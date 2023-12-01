import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {SystemsService} from "../../common/services/systems.service";
import {ProjectsTableComponent} from "../../common/standalone/projects-table/projects-table.component";
import {SystemInfoComponent} from "./system-info/system-info.component";
import { System } from '@core/system';
import {ActivatedRoute, Router} from "@angular/router";

@Component({
  selector: 'app-systems',
  standalone: true,
  imports: [CommonModule, ProjectsTableComponent, SystemInfoComponent,],
  templateUrl: './systems-details.component.html',
  styleUrl: './systems-details.component.css'
})
export class SystemsDetailsComponent implements OnInit{
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
