export function convertToDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate() + ' ' + date.getHours() + ':' + ('0' + date.getMinutes()).slice(-2);
}

export function monthYearToString(timestamp: number): string {
  const date = new Date(timestamp);
  let month = '';
  switch (date.getMonth() + 1) {
    case 1:
      month = 'Jan';
      break;
    case 2:
      month = 'Feb';
      break;
    case 3:
      month = 'Mar';
      break;
    case 4:
      month = 'Apr';
      break;
    case 5:
      month = 'May';
      break;
    case 6:
      month = 'Jun';
      break;
    case 7:
      month = 'Jul';
      break;
    case 8:
      month = 'Aug';
      break;
    case 9:
      month = 'Sep';
      break;
    case 10:
      month = 'Oct';
      break;
    case 11:
      month = 'Nov';
      break;
    case 12:
      month = 'Dec';
      break;
  }
  return month + '-' + date.getFullYear();
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
