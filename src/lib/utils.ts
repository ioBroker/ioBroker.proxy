// query parameters whose values must never appear in the log
const SECRET_PARAMS =
    /([?&;](?:password|passwd|pass|pwd|pw|user|username|usr|login|token|access_token|auth|apikey|api_key|key|secret)=)[^&#;]*/gi;

/**
 * Masks credentials in a URL for logging: `user:pass@` and the values of known secret query parameters.
 *
 * @param url URL or URL path to mask
 * @returns masked URL
 */
export function maskUrl(url: string): string {
    return String(url)
        .replace(/^(https?:\/\/)[^/@]+@/i, '$1***@')
        .replace(SECRET_PARAMS, '$1***');
}

/** `parseInt` for values that the old admin stored as strings and the new one as numbers */
export function toInt(value: number | string | undefined | null): number {
    return parseInt(String(value), 10);
}
