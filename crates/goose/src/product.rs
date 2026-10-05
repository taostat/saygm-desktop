use std::env;

const SAYGM_DESKTOP_ENV: &str = "SAYGM_DESKTOP";
const SAYGM_KEYRING_SERVICE: &str = "saygm-desktop";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProductPolicy {
    Standard,
    SayGmDesktop,
}

impl ProductPolicy {
    pub(crate) fn from_environment() -> Self {
        Self::from_environment_value(env::var(SAYGM_DESKTOP_ENV).ok().as_deref())
    }

    pub(crate) fn from_environment_value(value: Option<&str>) -> Self {
        match value {
            Some("1") => Self::SayGmDesktop,
            _ => Self::Standard,
        }
    }

    pub(crate) const fn is_saygm_desktop(self) -> bool {
        matches!(self, Self::SayGmDesktop)
    }

    pub(crate) const fn uses_isolated_config_paths(self) -> bool {
        self.is_saygm_desktop()
    }

    pub(crate) const fn allows_secret_environment_overrides(self) -> bool {
        !self.is_saygm_desktop()
    }

    pub(crate) const fn allows_keyring_disable(self) -> bool {
        !self.is_saygm_desktop()
    }

    pub(crate) const fn requires_system_keyring(self) -> bool {
        self.is_saygm_desktop()
    }

    pub(crate) const fn keyring_service(self, standard_service: &str) -> &str {
        if self.is_saygm_desktop() {
            SAYGM_KEYRING_SERVICE
        } else {
            standard_service
        }
    }
}

pub(crate) fn current_policy() -> ProductPolicy {
    ProductPolicy::from_environment()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_policy_activates_only_for_exact_flag_value() {
        assert_eq!(
            ProductPolicy::from_environment_value(None),
            ProductPolicy::Standard
        );
        assert_eq!(
            ProductPolicy::from_environment_value(Some("0")),
            ProductPolicy::Standard
        );
        assert_eq!(
            ProductPolicy::from_environment_value(Some("1")),
            ProductPolicy::SayGmDesktop
        );
        assert_eq!(
            ProductPolicy::from_environment_value(Some("true")),
            ProductPolicy::Standard
        );
        assert_eq!(
            ProductPolicy::from_environment_value(Some(" 1")),
            ProductPolicy::Standard
        );
    }

    #[test]
    fn desktop_policy_keeps_security_and_provider_restrictions_closed() {
        let policy = ProductPolicy::SayGmDesktop;
        assert!(policy.uses_isolated_config_paths());
        assert!(!policy.allows_secret_environment_overrides());
        assert!(!policy.allows_keyring_disable());
        assert!(policy.requires_system_keyring());
        assert_eq!(policy.keyring_service("goose"), SAYGM_KEYRING_SERVICE);

        let standard = ProductPolicy::Standard;
        assert!(!standard.uses_isolated_config_paths());
        assert!(standard.allows_secret_environment_overrides());
        assert!(standard.allows_keyring_disable());
        assert!(!standard.requires_system_keyring());
        assert_eq!(standard.keyring_service("goose"), "goose");
    }
}
