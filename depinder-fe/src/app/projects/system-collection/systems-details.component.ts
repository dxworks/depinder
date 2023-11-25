import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {SystemsService} from "../../common/services/systems.service";
import {ProjectsTableComponent} from "../../common/standalone/projects-table/projects-table.component";
import {SystemInfoComponent} from "./system-info/system-info.component";
import { System } from '@core/system';

@Component({
  selector: 'app-systems',
  standalone: true,
  imports: [CommonModule, ProjectsTableComponent, SystemInfoComponent,],
  templateUrl: './systems-details.component.html',
  styleUrl: './systems-details.component.css'
})
export class SystemsDetailsComponent implements OnInit{
  systems$: System[] = [];
  constructor(private systemService: SystemsService) {
  }

  ngOnInit() {
    this.systemService.all().subscribe(
      (res: any) => {
        this.systems$ = res.body['data'];
      }
    )
  }

}
