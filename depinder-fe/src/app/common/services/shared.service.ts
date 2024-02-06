import { Injectable } from '@angular/core';
import {BehaviorSubject} from "rxjs";

@Injectable({
  providedIn: 'root'
})
export class SharedService {
  private titleSource = new BehaviorSubject<string>('Default Title');
  currentTitle = this.titleSource.asObservable();

  constructor() { }

  updateTitle(title: string) {
    this.titleSource.next(title);
  }
}
