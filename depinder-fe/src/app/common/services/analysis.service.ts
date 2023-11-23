import {Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {API_URL} from "../constants";

const BASE_URL = API_URL;

@Injectable({
  providedIn: 'root'
})
export class AnalysisService {
  model = 'analyse'
  constructor(private http: HttpClient) {}

  analyse(path: string) {
    return this.http.post(this.getUrl(), {
      "folders" : [path],
      "options": {
        "plugins": [],
        "results": "",
        "refresh": false
      },
      "cache": true
    }, { observe: 'response' });
  }

  getUrl() {
    return `${BASE_URL}/${this.model}`;
  }
}
