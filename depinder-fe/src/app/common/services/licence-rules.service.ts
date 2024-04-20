import { Injectable } from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {Observable} from "rxjs";
import {LicenseRule} from "../models/licence-rule";

@Injectable({
  providedIn: 'root'
})
export class LicenceRulesService {
  private dataUrl = 'assets/rules.json';

  public permissions: LicenseRule[] = [];
  public conditions: LicenseRule[] = [];
  public limitations: LicenseRule[] = [];

  constructor(private http: HttpClient) {
    this.getRules().subscribe(data => {
      this.permissions = data.permissions;
      this.conditions = data.conditions;
      this.limitations = data.limitations;

      console.log(this.permissions);
      console.log(this.conditions);
      console.log(this.limitations);
    });
  }

  getRules(): Observable<any> {
    return this.http.get(this.dataUrl);
  }

  getPermissionRuleById(id: string): LicenseRule | undefined {
    return this.permissions.find(rule => rule.tag === id);
  }

  getConditionRuleById(id: string): LicenseRule | undefined {
    return this.conditions.find(rule => rule.tag === id);
  }

  getLimitationRuleById(id: string): LicenseRule | undefined {
    return this.limitations.find(rule => rule.tag === id);
  }
}
