import {AfterViewInit, Component, OnInit, ViewChild} from '@angular/core';
import {Router} from "@angular/router";
import {ToolbarService} from "./common/services/toolbar.service";
import {MatSidenav} from "@angular/material/sidenav";

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, AfterViewInit {
  title = '';
  htmlContent = '';

  @ViewChild('sidenav') sidenav!: MatSidenav;

  constructor(private router: Router, protected toolbarService: ToolbarService) {}

  ngOnInit() {
    this.toolbarService.currentTitle.subscribe(title => this.title = title);
  }

  ngAfterViewInit() {
    this.toolbarService.sidebar = this.sidenav;
  }

  navigate(path: string) {
    this.router.navigate([path]);
  }
}
