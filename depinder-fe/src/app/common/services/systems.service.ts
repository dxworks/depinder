import { Injectable } from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {API_URL} from "../constants";
import {System} from "@core/system";
import {map, Observable} from "rxjs";

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

  find(id: string): Observable<System> {
    return this.http.get<System>(this.getUrlWithID(id), { observe: 'response' }).pipe(
      map(response => response.body as System)
    );
  }

  //todo fix any
  createSystem(system: any) {
    return this.http.post(this.getUrl(), {
      "_id": system._id,
      "name": system.name,
      "projectPaths": system.projectPaths ?? [],
    });
  }

  updateSystem(id: string, name: string, newProjects: string[], deletedProjects: string[]) {
    return this.http.post(this.getUrlWithID(id), {
      "_id": id,
      "name": name,
      "newProjects": newProjects,
      "deletedProjects": deletedProjects
    });
  }

  getUrl() {
    return `${BASE_URL}/${this.model}`;
  }

  getUrlWithID(id: string) {
    return `${this.getUrl()}/${id}`;
  }

  deleteSystem(id: string) {
    return this.http.delete(this.getUrlWithID(id));
  }
}
