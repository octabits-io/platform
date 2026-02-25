export function normalizeQueryParamToStringOrUndefined(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value) && value.length > 0) {
    return value[0] // Return the first item if it's an array
  }
  else if (typeof value === 'string') {
    return value
  }
  else {
    return undefined
  }
}

export function normalizeQueryParamToIntOrUndefined(value: string | string[] | null | undefined): number | undefined {
  const sValue = normalizeQueryParamToStringOrUndefined(value)
  if (sValue === undefined) {
    return undefined
  }
  const num = Number.parseInt(sValue)
  return Number.isFinite(num) ? num : undefined
}

export function normalizeQueryParamToArrayOrUndefined(value: string | string[] | null | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    return value
  }
  else if (typeof value === 'string') {
    return [value]
  }
  else {
    return undefined
  }
}
