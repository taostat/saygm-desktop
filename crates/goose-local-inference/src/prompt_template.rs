use include_dir::{include_dir, Dir};
use minijinja::value::ObjectRepr;
use minijinja::{Environment, Error as MiniJinjaError, Value as MJValue};
use serde::Serialize;

use crate::paths::Paths;
use goose_provider_types::identity::SAYGM_IDENTITY;

static CORE_PROMPTS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/prompts");

pub(crate) fn tiny_model_system_prompt_fallback() -> String {
    format!(
        "You are {}, an AI assistant. You can execute shell commands by starting lines with $.",
        SAYGM_IDENTITY.name
    )
}

pub fn render_string<T: Serialize>(
    template_str: &str,
    context: &T,
) -> Result<String, MiniJinjaError> {
    let mut env = Environment::new();
    env.set_trim_blocks(true);
    env.set_lstrip_blocks(true);
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
    let user_path = Paths::config_dir().join("prompts").join(name);
    let template_str = if user_path.exists() {
        std::fs::read_to_string(&user_path).map_err(|e| {
            MiniJinjaError::new(
                minijinja::ErrorKind::InvalidOperation,
                format!("Failed to read user template: {}", e),
            )
        })?
    } else {
        let file = CORE_PROMPTS_DIR.get_file(name).ok_or_else(|| {
            MiniJinjaError::new(
                minijinja::ErrorKind::TemplateNotFound,
                format!("Built-in template '{}' not found", name),
            )
        })?;
        String::from_utf8_lossy(file.contents()).to_string()
    };

    render_string(&template_str, context)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_tiny_model_prompt_and_fallback_use_saygm_identity() {
        let file = CORE_PROMPTS_DIR
            .get_file("tiny_model_system.md")
            .expect("bundled tiny-model prompt");
        let template = String::from_utf8_lossy(file.contents());
        let context = serde_json::json!({});
        let prompt = render_string(&template, &context).unwrap();

        assert!(prompt.starts_with("You are SayGM, an autonomous AI assistant."));
        for prompt in [
            render_string(&template, &Option::<String>::None).unwrap(),
            render_string(&template, &()).unwrap(),
            render_string(&template, &serde_json::json!(["first"])).unwrap(),
        ] {
            assert!(prompt.starts_with("You are SayGM, an autonomous AI assistant."));
        }
        assert_eq!(render_string("{{ this }}", &"scalar").unwrap(), "");
        assert_eq!(
            render_string(
                "{% for item in this %}{{ item }}{% endfor %}",
                &serde_json::json!(["first"])
            )
            .unwrap(),
            ""
        );
        assert!(tiny_model_system_prompt_fallback().starts_with("You are SayGM,"));
    }

    #[test]
    fn render_string_reserves_product_identity_and_keeps_other_context() {
        let context = serde_json::json!({
            "product": {"name": "untrusted"},
            "os": "linux",
        });

        assert_eq!(
            render_string("{{ product.name }}:{{ os }}", &context).unwrap(),
            "SayGM:linux"
        );
    }
}
