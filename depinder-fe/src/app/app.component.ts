import {Component, OnInit} from '@angular/core';
import {Router} from "@angular/router";
import {SharedService} from "./common/services/shared.service";

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  title = 'Default Title';
  constructor(private router: Router, private sharedService: SharedService) {}

  ngOnInit() {
    this.sharedService.currentTitle.subscribe(title => {
      this.title = title;
    });
  }

  navigate(path: string) {
    this.router.navigate([path]);
  }
}
