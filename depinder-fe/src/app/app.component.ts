import { Component } from '@angular/core';
import {Router} from "@angular/router";

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  title = 'depinder-fe';

  constructor(private router: Router) {}

  navigate(path: string) {
    this.router.navigate([path]);
  }
}
