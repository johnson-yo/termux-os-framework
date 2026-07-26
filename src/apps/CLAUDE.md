# Application coordinator contract

Application sessions coordinate required Capabilities and service desired state without naming a provider implementation. Session state is runtime metadata, not product data. Recovery must restore the pre-session state after an interrupted workflow.
