export function applicationAllowed(payload, type) {
  const scope=Object.hasOwn(payload??{},"application_access")?payload.application_access:(Object.hasOwn(payload?.features??{},"application_access")?payload.features.application_access:"both"), bound=payload?.application_type??null;
  return ["desktop","web"].includes(type)&&["both","desktop","web"].includes(scope)&&(scope==="both"||scope===type)&&(bound===null?scope==="both":bound===type);
}
