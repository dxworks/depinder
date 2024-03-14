import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {MatSidenav} from "@angular/material/sidenav";

@Injectable({
  providedIn: 'root'
})
export class ToolbarService {
  private titleSource = new BehaviorSubject<string>('');
  currentTitle = this.titleSource.asObservable();
  sidebar: MatSidenav | undefined;

  constructor() {}

  changeTitle(title: string) {
    this.titleSource.next(title);
  }
}
