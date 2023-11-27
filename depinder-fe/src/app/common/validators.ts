import {FormControl} from "@angular/forms";

export function alphaNumericUnderscoreValidator(control: FormControl): { [key: string]: any } | null {
  const valid = /^[A-Za-z0-9_]+$/.test(control.value);
  return valid ? null : { 'invalidAlphaNumericUnderscore': true };
}
