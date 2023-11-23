import { Injectable } from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {API_URL} from "../constants";

const BASE_URL = API_URL;

@Injectable({
  providedIn: 'root'
})
export class SystemsService {
  model = 'system'

  constructor(private http: HttpClient) {}

  all() {
    return this.http.get(`${this.getUrl()}/all `, { observe: 'response' });
  }

  find(id: string) {
    return this.http.get(this.getUrlWithID(id));
  }

  getUrl() {
    return `${BASE_URL}/${this.model}`;
  }

  getUrlWithID(id: string) {
    return `${this.getUrl()}/${id}`;
  }
}
