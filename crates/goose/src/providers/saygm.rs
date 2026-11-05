use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures::future::BoxFuture;
use goose_providers::anthropic::{
    AnthropicProvider, AnthropicProviderBuilder, ANTHROPIC_API_VERSION,
};
use goose_providers::api_client::{ApiClient, AuthMethod, TlsConfig};
use goose_providers::base::{
    MessageStream, ModelInfo, Provider, ProviderDescriptor, ProviderMetadata,
};
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;
use goose_providers::openai::{OpenAiProvider, OpenAiProviderBuilder};
use goose_providers::openai_compatible::handle_response_openai_compat;
use rmcp::model::Tool;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use crate::config::{Config, ExtensionConfig};
use crate::providers::base::{ConfigKey, ProviderDef};
use crate::providers::catalog::{ProviderSetupGroup, ProviderSetupMetadata};

pub const SAYGM_PROVIDER_NAME: &str = "saygm";
pub const SAYGM_API_KEY: &str = "SAYGM_API_KEY";
const SAYGM_API_HOST: &str = "https://api.saygm.com";
const SAYGM_CHAT_COMPLETIONS_PATH: &str = "/v1/chat/completions";
const SAYGM_MODELS_PATH: &str = "v1/models";
const SHAPE_CHAT_COMPLETIONS: &str = "chat.completions";
const SHAPE_MESSAGES: &str = "messages";

/// Catalog `api_shapes` this provider can route. The model inventory cache is
/// keyed on this list, so supporting a new shape re-fetches the catalog
/// instead of serving a list cached by an older build for up to a day.
pub const SAYGM_ROUTED_API_SHAPES: [&str; 2] = [SHAPE_CHAT_COMPLETIONS, SHAPE_MESSAGES];

const SAYGM_CATALOG_TTL: Duration = Duration::from_secs(300);
static SAYGM_CATALOG: RwLock<Option<(Instant, Vec<SaygmModel>)>> = RwLock::const_new(None);

/// Wire protocol the SayGM gateway serves a model on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SaygmApiShape {
    ChatCompletions,
    Messages,
}

impl SaygmApiShape {
    /// Picks the shape to use from a catalog entry's `api_shapes`, preferring
    /// chat completions when a model offers both.
    fn select(shapes: &[Value]) -> Option<Self> {
        let offers = |name: &str| shapes.iter().any(|shape| shape.as_str() == Some(name));
        if offers(SHAPE_CHAT_COMPLETIONS) {
            Some(Self::ChatCompletions)
        } else if offers(SHAPE_MESSAGES) {
            Some(Self::Messages)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug)]
struct SaygmModel {
    info: ModelInfo,
    shape: SaygmApiShape,
}

pub struct SaygmProviderDef;

impl ProviderDescriptor for SaygmProviderDef {
    fn metadata() -> ProviderMetadata {
        ProviderMetadata::with_models(
            SAYGM_PROVIDER_NAME,
            "SayGM",
            "Use tool-capable chat and Claude models available through the SayGM gateway.",
            "",
            Vec::new(),
            "https://saygm.com",
            vec![ConfigKey::new(SAYGM_API_KEY, true, true, None, true)],
        )
        .with_setup(
            ProviderSetupMetadata::api_key(ProviderSetupGroup::Default)
                .with_docs_url("https://saygm.com"),
        )
        .with_setup_steps(vec![
            "Sign in with your SayGM account to connect this desktop app",
        ])
    }
}

impl ProviderDef for SaygmProviderDef {
    type Provider = SaygmProvider;

    fn from_env(
        _extensions: Vec<ExtensionConfig>,
        tls_config: Option<TlsConfig>,
    ) -> BoxFuture<'static, Result<Self::Provider>> {
        Box::pin(async move { SaygmProvider::from_config(tls_config).await })
    }
}

pub struct SaygmProvider {
    chat_completions: OpenAiProvider,
    messages: AnthropicProvider,
    models: Vec<ModelInfo>,
    shapes: HashMap<String, SaygmApiShape>,
    api_key_sha256: String,
}

impl SaygmProvider {
    async fn from_config(tls_config: Option<TlsConfig>) -> Result<Self> {
        let api_key: String = Config::global().get_secret(SAYGM_API_KEY)?;
        let models = saygm_models(tls_config.clone()).await?;
        Self::new(SAYGM_API_HOST, api_key, models, tls_config)
    }

    fn new(
        host: &str,
        api_key: String,
        catalog: Vec<SaygmModel>,
        tls_config: Option<TlsConfig>,
    ) -> Result<Self> {
        let api_key_sha256 = Sha256::digest(api_key.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let models_for = |shape: SaygmApiShape| {
            catalog
                .iter()
                .filter(|model| model.shape == shape)
                .map(|model| model.info.clone())
                .collect::<Vec<_>>()
        };

        let chat_client = ApiClient::new_with_tls(
            host.to_string(),
            AuthMethod::BearerToken(api_key.clone()),
            tls_config.clone(),
        )?
        .with_request_builder(crate::session_context::session_id_request_builder());
        let chat_completions = OpenAiProviderBuilder::new(chat_client)
            .name(SAYGM_PROVIDER_NAME)
            .base_path(SAYGM_CHAT_COMPLETIONS_PATH)
            .custom_models(Some(models_for(SaygmApiShape::ChatCompletions)))
            .dynamic_models(Some(false))
            .build();

        let messages_client = ApiClient::new_with_tls(
            host.to_string(),
            AuthMethod::ApiKey {
                header_name: "x-api-key".to_string(),
                key: api_key,
            },
            tls_config,
        )?
        .with_request_builder(crate::session_context::session_id_request_builder())
        .with_header("anthropic-version", ANTHROPIC_API_VERSION)?;
        let messages = AnthropicProviderBuilder::new(messages_client)
            .name(SAYGM_PROVIDER_NAME)
            .custom_models(Some(models_for(SaygmApiShape::Messages)))
            .dynamic_models(Some(false))
            .build();

        let shapes = catalog
            .iter()
            .map(|model| (model.info.name.clone(), model.shape))
            .collect();
        let models = catalog.into_iter().map(|model| model.info).collect();

        Ok(Self {
            chat_completions,
            messages,
            models,
            shapes,
            api_key_sha256,
        })
    }

    async fn stream_model(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[goose_providers::conversation::message::Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        match self.shapes.get(&model_config.model_name) {
            Some(SaygmApiShape::ChatCompletions) => {
                self.chat_completions
                    .stream(model_config, system, messages, tools)
                    .await
            }
            Some(SaygmApiShape::Messages) => {
                self.messages
                    .stream(model_config, system, messages, tools)
                    .await
            }
            None => Err(ProviderError::InvalidValue(format!(
                "Model '{}' is not available through SayGM",
                model_config.model_name
            ))),
        }
    }
}

#[async_trait]
impl Provider for SaygmProvider {
    fn get_name(&self) -> &str {
        SAYGM_PROVIDER_NAME
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[goose_providers::conversation::message::Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let key_is_current = Config::global()
            .secret_sha256_matches_fresh(SAYGM_API_KEY, &self.api_key_sha256)
            .unwrap_or(false);
        if !key_is_current {
            return Err(ProviderError::NotConfigured);
        }

        self.stream_model(model_config, system, messages, tools)
            .await
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(self.models.iter().map(|model| model.name.clone()).collect())
    }

    async fn fetch_supported_model_info(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(self.models.clone())
    }
}

async fn saygm_models(tls_config: Option<TlsConfig>) -> Result<Vec<SaygmModel>> {
    {
        let cache = SAYGM_CATALOG.read().await;
        if let Some((fetched_at, models)) = cache.as_ref() {
            if fetched_at.elapsed() < SAYGM_CATALOG_TTL {
                return Ok(models.clone());
            }
        }
    }

    let mut cache = SAYGM_CATALOG.write().await;
    if let Some((fetched_at, models)) = cache.as_ref() {
        if fetched_at.elapsed() < SAYGM_CATALOG_TTL {
            return Ok(models.clone());
        }
    }

    let models = fetch_saygm_models(tls_config).await?;
    *cache = Some((Instant::now(), models.clone()));
    Ok(models)
}

async fn fetch_saygm_models(tls_config: Option<TlsConfig>) -> Result<Vec<SaygmModel>> {
    let client =
        ApiClient::new_with_tls(SAYGM_API_HOST.to_string(), AuthMethod::NoAuth, tls_config)?;
    let response = client.request(SAYGM_MODELS_PATH).response_get().await?;
    let body = handle_response_openai_compat(response).await?;
    parse_saygm_models(&body)
}

fn parse_saygm_models(body: &Value) -> Result<Vec<SaygmModel>> {
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("SayGM returned an unexpected model list"))?;

    let mut models = data
        .iter()
        .filter(|model| model.get("available").and_then(Value::as_bool) == Some(true))
        .filter(|model| {
            model
                .get("capabilities")
                .and_then(|capabilities| capabilities.get("tools"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .filter_map(|model| {
            let id = model.get("id").and_then(Value::as_str)?;
            if id.trim().is_empty() {
                return None;
            }
            let shapes = model.get("api_shapes").and_then(Value::as_array)?;
            Some(SaygmModel {
                info: ModelInfo::new(id),
                shape: SaygmApiShape::select(shapes)?,
            })
        })
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.info.name.cmp(&right.info.name));

    if models.is_empty() {
        return Err(anyhow!(
            "SayGM has no available tool-capable chat-completions or messages models"
        ));
    }

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::{parse_saygm_models, SaygmApiShape, SaygmModel, SaygmProvider};
    use goose_providers::base::ModelInfo;
    use goose_providers::conversation::message::Message;
    use goose_providers::errors::ProviderError;
    use goose_providers::model::ModelConfig;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn names_and_shapes(models: &[SaygmModel]) -> Vec<(&str, SaygmApiShape)> {
        models
            .iter()
            .map(|model| (model.info.name.as_str(), model.shape))
            .collect()
    }

    #[test]
    fn only_returns_available_tool_capable_models_with_a_supported_shape() {
        let body = json!({
            "data": [
                {
                    "id": "zeta-chat",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": ["chat.completions"]
                },
                {
                    "id": "unavailable-chat",
                    "available": false,
                    "capabilities": { "tools": true },
                    "api_shapes": ["chat.completions"]
                },
                {
                    "id": "no-tools-chat",
                    "available": true,
                    "capabilities": { "tools": false },
                    "api_shapes": ["chat.completions"]
                },
                {
                    "id": "responses-only",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": ["responses"]
                },
                {
                    "id": "gemini-generate-content",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": ["generateContent", "streamGenerateContent"]
                },
                {
                    "id": "no-shapes",
                    "available": true,
                    "capabilities": { "tools": true }
                },
                {
                    "id": "empty-shapes",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": []
                },
                {
                    "id": "  ",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": ["messages"]
                },
                {
                    "id": "unavailable-claude",
                    "available": false,
                    "capabilities": { "tools": true },
                    "api_shapes": ["messages"]
                },
                {
                    "id": "claude-sonnet",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": ["messages"]
                },
                {
                    "id": "alpha-chat",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": ["chat.completions", "responses"]
                }
            ]
        });

        let models = parse_saygm_models(&body).expect("eligible models should be available");

        assert_eq!(
            names_and_shapes(&models),
            [
                ("alpha-chat", SaygmApiShape::ChatCompletions),
                ("claude-sonnet", SaygmApiShape::Messages),
                ("zeta-chat", SaygmApiShape::ChatCompletions),
            ]
        );
    }

    #[test]
    fn prefers_chat_completions_when_a_model_offers_both_shapes() {
        let body = json!({
            "data": [{
                "id": "dual-shape",
                "available": true,
                "capabilities": { "tools": true },
                "api_shapes": ["messages", "chat.completions"]
            }]
        });

        let models = parse_saygm_models(&body).expect("dual-shape model should be eligible");

        assert_eq!(
            names_and_shapes(&models),
            [("dual-shape", SaygmApiShape::ChatCompletions)]
        );
    }

    #[test]
    fn rejects_catalog_with_no_available_tool_capable_models() {
        let body = json!({
            "data": [
                {
                    "id": "unavailable-chat",
                    "available": false,
                    "capabilities": { "tools": true },
                    "api_shapes": ["chat.completions"]
                },
                {
                    "id": "gemini-only",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": ["generateContent"]
                }
            ]
        });

        let error = parse_saygm_models(&body).expect_err("empty eligible catalog should fail");

        assert!(error
            .to_string()
            .contains("SayGM has no available tool-capable chat-completions or messages models"));
    }

    #[test]
    fn rejects_malformed_catalog_response() {
        let error = parse_saygm_models(&json!({ "data": null }))
            .expect_err("malformed catalog should fail");

        assert!(error
            .to_string()
            .contains("SayGM returned an unexpected model list"));
    }

    fn catalog() -> Vec<SaygmModel> {
        vec![
            SaygmModel {
                info: ModelInfo::new("claude-sonnet"),
                shape: SaygmApiShape::Messages,
            },
            SaygmModel {
                info: ModelInfo::new("open-chat"),
                shape: SaygmApiShape::ChatCompletions,
            },
        ]
    }

    async fn mount_endpoints(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "test-key"))
            .and(header("anthropic-version", super::ANTHROPIC_API_VERSION))
            .respond_with(ResponseTemplate::new(200).set_body_raw("", "text/event-stream"))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_raw("", "text/event-stream"))
            .mount(server)
            .await;
    }

    async fn requested_paths(server: &MockServer) -> Vec<String> {
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .iter()
            .map(|request| request.url.path().to_string())
            .collect()
    }

    async fn requested_models(server: &MockServer) -> Vec<String> {
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .iter()
            .map(|request| {
                let body: serde_json::Value =
                    serde_json::from_slice(&request.body).expect("request body should be JSON");
                body["model"].as_str().unwrap_or_default().to_string()
            })
            .collect()
    }

    #[tokio::test]
    async fn routes_each_model_to_the_endpoint_for_its_shape() {
        let server = MockServer::start().await;
        mount_endpoints(&server).await;
        let provider = SaygmProvider::new(&server.uri(), "test-key".into(), catalog(), None)
            .expect("provider should build");
        let prompt = [Message::user().with_text("hello")];

        let _messages_stream = provider
            .stream_model(&ModelConfig::new("claude-sonnet"), "system", &prompt, &[])
            .await
            .expect("messages model should reach the Messages endpoint");
        assert_eq!(requested_paths(&server).await, ["/v1/messages"]);
        assert_eq!(requested_models(&server).await, ["claude-sonnet"]);

        let _chat_stream = provider
            .stream_model(&ModelConfig::new("open-chat"), "system", &prompt, &[])
            .await
            .expect("chat model should reach the chat completions endpoint");
        assert_eq!(
            requested_paths(&server).await,
            ["/v1/messages", "/v1/chat/completions"]
        );
        assert_eq!(
            requested_models(&server).await,
            ["claude-sonnet", "open-chat"]
        );
    }

    #[tokio::test]
    async fn rejects_models_outside_the_catalog_without_a_request() {
        let server = MockServer::start().await;
        mount_endpoints(&server).await;
        let provider = SaygmProvider::new(&server.uri(), "test-key".into(), catalog(), None)
            .expect("provider should build");
        let prompt = [Message::user().with_text("hello")];

        let error = match provider
            .stream_model(&ModelConfig::new("unknown-model"), "system", &prompt, &[])
            .await
        {
            Ok(_) => panic!("unknown model should be rejected"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            ProviderError::InvalidValue(message)
                if message == "Model 'unknown-model' is not available through SayGM"
        ));
        assert!(requested_paths(&server).await.is_empty());
    }

    #[tokio::test]
    async fn lists_models_from_both_shapes() {
        let provider = SaygmProvider::new("http://127.0.0.1:9", "test-key".into(), catalog(), None)
            .expect("provider should build");

        assert_eq!(
            goose_providers::base::Provider::fetch_supported_models(&provider)
                .await
                .expect("catalog should list"),
            ["claude-sonnet", "open-chat"]
        );
    }
}
