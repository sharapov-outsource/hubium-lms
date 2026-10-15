/** Whether a stored address may be a link: http(s) only, never javascript: or data:. */
export const isWebLink = (url: string) => /^https?:\/\//i.test(url);
