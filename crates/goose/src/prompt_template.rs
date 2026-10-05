use crate::config::paths::Paths;
use goose_provider_types::identity::SAYGM_IDENTITY;
use include_dir::{include_dir, Dir};
use minijinja::value::ObjectRepr;
use minijinja::{Environment, Error as MiniJinjaError, Value as MJValue};
use serde::Serialize;
use std::path::PathBuf;

static CORE_PROMPTS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/prompts");

static TEMPLATE_REGISTRY: &[(&str, &str)] = &[
    (
        "system.md",
        "Main system prompt that defines the assistant's personality and behavior",
    ),
    (
        "compaction.md",
        "Prompt for summarizing conversation history when context limits are reached",
    ),
    (
        "compaction_summary.md",
        "Renders the structured compaction output into the post-compaction context",
    ),
    (
        "subagent_system.md",
        "System prompt for subagents spawned to handle specific tasks",
    ),
    (
        "apps_create.md",
        "Prompt for generating new apps based on the user instructions",
    ),
    (
        "apps_iterate.md",
        "Prompt for updating existing apps based on feedback",
    ),
    (
        "permission_judge.md",
        "Prompt for analyzing tool operations for read-only detection",
    ),
    (
        "tiny_model_system.md",
        "System prompt for tiny local models using shell command emulation",
    ),
    (
        "session_name.md",
        "System prompt for generating short session names from conversation history",
    ),
];

/// Information about a template including its content and customization status
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Template {
    pub name: String,
    pub description: String,
    pub default_content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_content: Option<String>,
    pub is_customized: bool,
}

fn builtin_content(name: &str) -> Option<String> {
    CORE_PROMPTS_DIR
        .get_file(name)
        .map(|file| String::from_utf8_lossy(file.contents()).to_string())
        .or_else(|| goose_context_management::templates::builtin_template(name))
}

fn user_prompts_dir() -> PathBuf {
    Paths::config_dir().join("prompts")
}

fn is_registered(name: &str) -> bool {
    TEMPLATE_REGISTRY.iter().any(|(n, _)| *n == name)
}

/// Wrap code in a markdown fence longer than any backtick run it contains,
/// so embedded fences cannot close the block early.
fn code_fence(code: String) -> String {
    let longest_run = code
        .chars()
        .fold((0usize, 0usize), |(max, run), c| {
            if c == '`' {
                (max.max(run + 1), run + 1)
            } else {
                (max, 0)
            }
        })
        .0;
    let fence = "`".repeat((longest_run + 1).max(3));
    format!("{fence}\n{}\n{fence}", code.trim_end_matches('\n'))
}

pub fn render_string<T: Serialize>(
    template_str: &str,
    context: &T,
) -> Result<String, MiniJinjaError> {
    let mut env = Environment::new();
    env.set_trim_blocks(true);
    env.set_lstrip_blocks(true);
    env.add_filter("code_fence", code_fence);
    env.add_global("product", MJValue::from_serialize(SAYGM_IDENTITY));
    env.add_template("template", template_str)?;
    let tmpl = env.get_template("template")?;
    let original_context = MJValue::from_serialize(context);
    let ctx = if original_context
        .as_object()
        .is_some_and(|object| object.repr() == ObjectRepr::Map)
    {
        minijinja::context! {
            product => minijinja::context!(name => SAYGM_IDENTITY.name),
            ..original_context
        }
    } else {
        original_context
    };
    let rendered = tmpl.render(ctx)?;
    Ok(rendered.trim().to_string())
}

pub fn render_template<T: Serialize>(name: &str, context: &T) -> Result<String, MiniJinjaError> {
    if !is_registered(name) {
        return Err(MiniJinjaError::new(
            minijinja::ErrorKind::TemplateNotFound,
            format!("Template '{}' is not registered", name),
        ));
    }

    let user_path = user_prompts_dir().join(name);
    let template_str = if user_path.exists() {
        std::fs::read_to_string(&user_path).map_err(|e| {
            MiniJinjaError::new(
                minijinja::ErrorKind::InvalidOperation,
                format!("Failed to read user template: {}", e),
            )
        })?
    } else {
        builtin_content(name).ok_or_else(|| {
            MiniJinjaError::new(
                minijinja::ErrorKind::TemplateNotFound,
                format!("Built-in template '{}' not found", name),
            )
        })?
    };

    render_string(&template_str, context)
}

pub fn template_source(name: &str) -> Result<String, MiniJinjaError> {
    let user_path = user_prompts_dir().join(name);
    if user_path.exists() {
        return std::fs::read_to_string(&user_path).map_err(|e| {
            MiniJinjaError::new(
                minijinja::ErrorKind::InvalidOperation,
                format!("Failed to read user template: {}", e),
            )
        });
    }
    builtin_content(name).ok_or_else(|| {
        MiniJinjaError::new(
            minijinja::ErrorKind::TemplateNotFound,
            format!("Built-in template '{}' not found", name),
        )
    })
}

pub fn get_template(name: &str) -> Option<Template> {
    let (_, description) = TEMPLATE_REGISTRY.iter().find(|(n, _)| *n == name)?;

    let default_content = builtin_content(name)?;

    let user_path = user_prompts_dir().join(name);
    let user_content = if user_path.exists() {
        std::fs::read_to_string(&user_path).ok()
    } else {
        None
    };

    let is_customized = user_content.is_some();

    Some(Template {
        name: name.to_string(),
        description: description.to_string(),
        default_content,
        user_content,
        is_customized,
    })
}

pub fn save_template(name: &str, content: &str) -> std::io::Result<()> {
    if !is_registered(name) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Template '{}' is not registered", name),
        ));
    }

    let prompts_dir = user_prompts_dir();
    std::fs::create_dir_all(&prompts_dir)?;
    let path = prompts_dir.join(name);
    std::fs::write(path, content)
}

/// Reset a template to its default by removing the user customization.
pub fn reset_template(name: &str) -> std::io::Result<()> {
    if !is_registered(name) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Template '{}' is not registered", name),
        ));
    }

    let path = user_prompts_dir().join(name);
    if path.exists() {
        std::fs::remove_file(path)
    } else {
        Ok(())
    }
}

pub fn list_templates() -> Vec<Template> {
    TEMPLATE_REGISTRY
        .iter()
        .filter_map(|(name, description)| {
            let default_content = builtin_content(name)?;

            let user_path = user_prompts_dir().join(name);
            let user_content = if user_path.exists() {
                std::fs::read_to_string(&user_path).ok()
            } else {
                None
            };

            let is_customized = user_content.is_some();

            Some(Template {
                name: name.to_string(),
                description: description.to_string(),
                default_content,
                user_content,
                is_customized,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_get_template() {
        let template = get_template("system.md");
        assert!(template.is_some(), "system.md should be registered");

        let template = template.unwrap();
        assert_eq!(template.name, "system.md");
        assert!(!template.description.is_empty());
        assert!(!template.default_content.is_empty());
        assert!(!template.is_customized);
    }

    #[test]
    fn test_render_template() {
        let context: HashMap<String, String> = HashMap::new();
        let result = render_template("system.md", &context);
        assert!(result.is_ok(), "Should be able to render system.md");
        assert!(!result.unwrap().is_empty());
    }

    #[test]
    fn render_string_reserves_product_identity_and_preserves_other_context_fields() {
        let context = serde_json::json!({
            "product": {"name": "untrusted"},
            "value": "kept",
        });

        let rendered = render_string("{{ product.name }}:{{ value }}", &context).unwrap();

        assert_eq!(rendered, "SayGM:kept");
    }

    #[test]
    fn render_string_injects_identity_without_changing_non_map_contexts() {
        assert_eq!(render_string("{{ this }}", &"scalar").unwrap(), "");
        assert_eq!(
            render_string(
                "{{ this is none }}:{{ product.name }}",
                &Option::<String>::None
            )
            .unwrap(),
            "False:SayGM"
        );
        assert_eq!(
            render_string(
                "{% for item in this %}{{ item }}{% endfor %}:{{ product.name }}",
                &serde_json::json!(["one", "two"])
            )
            .unwrap(),
            ":SayGM"
        );
        assert_eq!(render_string("{{ product.name }}", &()).unwrap(), "SayGM");
    }

    #[test]
    fn test_list_templates() {
        let templates = list_templates();
        assert_eq!(templates.len(), TEMPLATE_REGISTRY.len());

        let has_system = templates.iter().any(|t| t.name == "system.md");
        assert!(has_system, "system.md should be in the template list");

        for template in templates {
            assert!(
                !template.description.is_empty(),
                "Each template should have a description"
            );
            assert!(
                !template.default_content.is_empty(),
                "Each template should have content"
            );
        }
    }

    #[test]
    fn bundled_agent_prompts_use_saygm_identity() {
        fn assert_prompt_identity<T: Serialize>(context: &T) {
            for (name, expected_identity) in [
                (
                    "system.md",
                    "You are SayGM, a general-purpose AI assistant.",
                ),
                (
                    "subagent_system.md",
                    "You are a specialized subagent working with SayGM",
                ),
                (
                    "tiny_model_system.md",
                    "You are SayGM, an autonomous AI assistant.",
                ),
            ] {
                let template = builtin_content(name).expect("bundled prompt");
                let prompt = render_string(&template, context).expect("bundled prompt renders");
                assert!(prompt.starts_with(expected_identity), "{name}");
                assert!(!prompt.contains("created by AAIF"), "{name}");
            }
        }

        assert_prompt_identity(&Option::<String>::None);
        assert_prompt_identity(&());
        assert_prompt_identity(&serde_json::json!(["first", "second"]));

        let empty_context = HashMap::<String, String>::new();
        assert_prompt_identity(&empty_context);
    }
}
