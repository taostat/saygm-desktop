use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ProductIdentity {
    pub name: &'static str,
}

pub const SAYGM_IDENTITY: ProductIdentity = ProductIdentity { name: "SayGM" };
