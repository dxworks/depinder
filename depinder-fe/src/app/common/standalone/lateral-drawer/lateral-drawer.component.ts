import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatButtonModule} from "@angular/material/button";
import {MatIconModule} from "@angular/material/icon";
import {MatLineModule} from "@angular/material/core";
import {MatListModule} from "@angular/material/list";
import {MatMenuModule} from "@angular/material/menu";
import {MatSidenavModule} from "@angular/material/sidenav";
import {MatToolbarModule} from "@angular/material/toolbar";
import {System} from "@core/system";
import {SystemsService} from "../../services/systems.service";
import {filter, Subject, takeUntil} from "rxjs";
import {
  Router,
  Event as RouterEvent,
  NavigationEnd,
  ActivatedRoute,
  UrlSegment,
  UrlSegmentGroup, UrlTree
} from '@angular/router';

@Component({
  selector: 'app-lateral-drawer',
  standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule, MatLineModule, MatListModule, MatMenuModule, MatSidenavModule, MatToolbarModule],
  templateUrl: './lateral-drawer.component.html',
  styleUrl: './lateral-drawer.component.css'
})
export class LateralDrawerComponent implements OnInit {
  private destroy$ = new Subject<void>();
  systems$: System[] = [];
  selected?: System;

  constructor(private router: Router, private systemService: SystemsService) {}

  ngOnInit() {
    this.systemService.all().pipe(takeUntil(this.destroy$)).subscribe(
      (res: any) => {
        this.systems$ = res.body['data'];
        this.selectSystemFromStorage();
      }
    );

    this.router.events.pipe(
      filter((event: RouterEvent) => event instanceof NavigationEnd),
      takeUntil(this.destroy$)
    ).subscribe(() => {
      const systemId = this.router.url.split('/')[2];
      this.selectSystemById(systemId);
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  selectSystemFromStorage() {
    const storedSystemId = localStorage.getItem('selectedSystemId');
    if (storedSystemId) {
      this.selectSystemById(storedSystemId);
    }
  }

  selectSystemById(id: string) {
    this.selected = this.systems$.find(system => system._id === id);
    if (this.selected) {
      localStorage.setItem('selectedSystemId', this.selected._id);
    }
  }

  navigate(path: string) {
    this.router.navigate([path]);
  }

  selectSystem(system: System) {
    this.router.navigate(['systems', system._id]);
    this.selected = system;
    localStorage.setItem('selectedSystemId', system._id);
  }
}
