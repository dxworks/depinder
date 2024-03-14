import { Injectable } from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {API_URL} from "../constants";

const BASE_URL = API_URL;

@Injectable({
  providedIn: 'root'
})
export class LicencesService {
  model = 'licence'
  constructor(private http: HttpClient) {}

  all() {
    return this.http.get(`${this.getUrl()}/all`, { observe: 'response' });
  }

  getById(id: string) {
    return this.http.get(`${this.getUrl()}/${id}`, { observe: 'response' });
  }

  getByProjectId(id: string) {
    return this.http.get(`${this.getUrl()}/project/${id}`, { observe: 'response' });
  }

  findSimilar(id: string) {
    return this.http.get(`${this.getUrl()}/similar/${id}`, { observe: 'response' });
  }

  create(licence: any) {
    console.log("here");
    return this.http.post(`${this.getUrl()}`, licence, { observe: 'response' });
  }

  addAlias(id: string, alias: string) {
    console.log(id, alias);
    return this.http.post(`${this.getUrl()}/alias`, { id: id, alias: alias }, { observe: 'response' });
  }

  getUrl() {
    return `${BASE_URL}/${this.model}`;
  }
}
