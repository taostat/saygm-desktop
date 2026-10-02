use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures::future::BoxFuture;
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
use std::collections::HashSet;
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

const SAYGM_CATALOG_TTL: Duration = Duration::from_secs(300);
static SAYGM_CATALOG: RwLock<Option<(Instant, Vec<ModelInfo>)>> = RwLock::const_new(None);

pub struct SaygmProviderDef;

impl ProviderDescriptor for SaygmProviderDef {
    fn metadata() -> ProviderMetadata {
        ProviderMetadata::with_models(
            SAYGM_PROVIDER_NAME,
            "SayGM",
            "Use tool-capable chat models available through the SayGM gateway.",
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
    inner: OpenAiProvider,
    models: Vec<ModelInfo>,
    model_ids: HashSet<String>,
    api_key_sha256: String,
}

impl SaygmProvider {
    async fn from_config(tls_config: Option<TlsConfig>) -> Result<Self> {
        let config = Config::global();
        let api_key: String = config.get_secret(SAYGM_API_KEY)?;
        let api_key_sha256 = Sha256::digest(api_key.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let models = saygm_models(tls_config.clone()).await?;
        let model_ids = models.iter().map(|model| model.name.clone()).collect();

        let client = ApiClient::new_with_tls(
            SAYGM_API_HOST.to_string(),
            AuthMethod::BearerToken(api_key),
            tls_config,
        )?
        .with_request_builder(crate::session_context::session_id_request_builder());

        let inner = OpenAiProviderBuilder::new(client)
            .name(SAYGM_PROVIDER_NAME)
            .base_path(SAYGM_CHAT_COMPLETIONS_PATH)
            .custom_models(Some(models.clone()))
            .dynamic_models(Some(false))
            .build();

        Ok(Self {
            inner,
            models,
            model_ids,
            api_key_sha256,
        })
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

        if !self.model_ids.contains(&model_config.model_name) {
            return Err(ProviderError::InvalidValue(format!(
                "Model '{}' is not available for SayGM chat completions",
                model_config.model_name
            )));
        }

        self.inner
            .stream(model_config, system, messages, tools)
            .await
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(self.models.iter().map(|model| model.name.clone()).collect())
    }

    async fn fetch_supported_model_info(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(self.models.clone())
    }
}

async fn saygm_models(tls_config: Option<TlsConfig>) -> Result<Vec<ModelInfo>> {
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

async fn fetch_saygm_models(tls_config: Option<TlsConfig>) -> Result<Vec<ModelInfo>> {
    let client =
        ApiClient::new_with_tls(SAYGM_API_HOST.to_string(), AuthMethod::NoAuth, tls_config)?;
    let response = client.request(SAYGM_MODELS_PATH).response_get().await?;
    let body = handle_response_openai_compat(response).await?;
    parse_saygm_models(&body)
}

fn parse_saygm_models(body: &Value) -> Result<Vec<ModelInfo>> {
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
        .filter(|model| {
            model
                .get("api_shapes")
                .and_then(Value::as_array)
                .is_some_and(|shapes| {
                    shapes
                        .iter()
                        .any(|shape| shape.as_str() == Some("chat.completions"))
                })
        })
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .map(ModelInfo::new)
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.name.cmp(&right.name));

    if models.is_empty() {
        return Err(anyhow!(
            "SayGM has no available tool-capable chat-completions models"
        ));
    }

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::parse_saygm_models;
    use serde_json::json;

    #[test]
    fn only_returns_available_tool_capable_chat_completion_models() {
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
                    "id": "alpha-chat",
                    "available": true,
                    "capabilities": { "tools": true },
                    "api_shapes": ["chat.completions"]
                }
            ]
        });

        let models = parse_saygm_models(&body).expect("eligible models should be available");

        assert_eq!(
            models
                .iter()
                .map(|model| model.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha-chat", "zeta-chat"]
        );
    }

    #[test]
    fn rejects_catalog_with_no_available_tool_capable_chat_models() {
        let body = json!({
            "data": [{
                "id": "unavailable-chat",
                "available": false,
                "capabilities": { "tools": true },
                "api_shapes": ["chat.completions"]
            }]
        });

        let error = parse_saygm_models(&body).expect_err("empty eligible catalog should fail");

        assert!(error
            .to_string()
            .contains("SayGM has no available tool-capable chat-completions models"));
    }

    #[test]
    fn rejects_malformed_catalog_response() {
        let error = parse_saygm_models(&json!({ "data": null }))
            .expect_err("malformed catalog should fail");

        assert!(error
            .to_string()
            .contains("SayGM returned an unexpected model list"));
    }
}
