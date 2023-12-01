import { Injectable } from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {API_URL} from "../constants";
import {System} from "@core/system";

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
    return this.http.get(this.getUrlWithID(id), { observe: 'response' });
  }

  //todo fix any
  createSystem(system: any) {
    return this.http.post(this.getUrl(), {
      "_id": system._id,
      "name": system.name,
      "projectPaths": system.projectPaths,
    });
  }

  getUrl() {
    return `${BASE_URL}/${this.model}`;
  }

  getUrlWithID(id: string) {
    return `${this.getUrl()}/${id}`;
  }
}
