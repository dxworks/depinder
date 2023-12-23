import { Injectable } from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {API_URL} from "../constants";
import {Dependency, Project} from '@core/project';
import {Observable} from "rxjs";

const BASE_URL = API_URL;

@Injectable({
  providedIn: 'root'
})
export class ProjectsService {
  model = 'project'
  constructor(private http: HttpClient) {}

  all() {
    return this.http.get(`${this.getUrl()}/all `, { observe: 'response' });
  }

  find(id: string): Observable<Project> {
    return this.http.get(this.getUrlWithID(id)) as Observable<Project>;
  }

  getPath(id: string): Observable<JSON> {
    return this.http.get(`${this.getUrlWithID(id)}/path`) as Observable<JSON>;
  }

  getUrl() {
    return `${BASE_URL}/${this.model}`;
  }

  getUrlWithID(id: string) {
    return `${this.getUrl()}/${id}`;
  }

  // todo move from here idk where
  getDependenciesByRequestedBy(dependencies: Dependency[], requestedBy: string) {
    return dependencies.filter(dep => dep.requestedBy.includes(requestedBy));
  }
}
