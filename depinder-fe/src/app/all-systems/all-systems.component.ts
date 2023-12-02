import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {SystemsService} from "../common/services/systems.service";
import {SystemInfoComponent} from "./system-info/system-info.component";
import { System } from '@core/system';
import {ActivatedRoute, Router} from "@angular/router";
import {ProjectsTableComponent} from "../common/standalone/projects-table/projects-table.component";
import {MatListModule} from "@angular/material/list";

@Component({
  selector: 'app-systems',
  standalone: true,
  imports: [CommonModule, ProjectsTableComponent, SystemInfoComponent, MatListModule,],
  templateUrl: './all-systems.component.html',
  styleUrl: './all-systems.component.css'
})
export class AllSystemsComponent implements OnInit{
  systems$: System[] = [];
  constructor(private systemService: SystemsService, private router: Router, private route: ActivatedRoute) {
  }

  ngOnInit() {
    this.systemService.all().subscribe(
      (res: any) => {
        this.systems$ = res.body['data'];
      }
    )
  }

  navigate(path: string) {
    this.router.navigate([path], { relativeTo: this.route });
  }
}
