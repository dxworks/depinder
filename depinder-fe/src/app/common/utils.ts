export function convertToDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate() + ' ' + date.getHours() + ':' + ('0' + date.getMinutes()).slice(-2);
}

export function extractDomain(url: string): string {
    const urlObj = new URL(url);
    return urlObj.hostname;
}

export function navigateToUrl(url: string): void {
  window.open(url, '_blank');
}

export function convertNumberToDate(timestamp: number): Date {
  return new Date(timestamp);
}
