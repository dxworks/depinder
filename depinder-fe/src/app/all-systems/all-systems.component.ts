import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {SystemsService} from "../common/services/systems.service";
import {SystemInfoComponent} from "./system-info/system-info.component";
import { System } from '@core/system';
import {ActivatedRoute, Router} from "@angular/router";
import {ProjectsTableComponent} from "../common/standalone/projects-table/projects-table.component";
import {MatListModule} from "@angular/material/list";
import {MatIconModule} from "@angular/material/icon";
import {MatButtonModule} from "@angular/material/button";
import {MatToolbarModule} from "@angular/material/toolbar";
import {ToolbarService} from "../common/services/toolbar.service";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {convertToDateString} from "../common/utils";

@Component({
  selector: 'app-systems',
  standalone: true,
  imports: [CommonModule, ProjectsTableComponent, SystemInfoComponent, MatListModule, MatIconModule, MatButtonModule, MatToolbarModule, MatTableModule,],
  templateUrl: './all-systems.component.html',
  styleUrl: './all-systems.component.css'
})
export class AllSystemsComponent implements OnInit{
  systems$: System[] = [];

  displayedColumns: string[] = ['position', 'id', 'name', 'latestRun'];
  dataSource = new MatTableDataSource(this.systems$);

  constructor(private systemService: SystemsService,
              private router: Router,
              private route: ActivatedRoute,
              protected toolbarService: ToolbarService)
  {}

  ngOnInit() {
    this.systemService.all().subscribe(
      (res: any) => {
        this.systems$ = res.body['data'];
        this.dataSource = new MatTableDataSource(this.systems$);
      }
    )
  }

  newSystem() {
    this.router.navigate(['systems/new'])
  }

  navigate(path: string[]) {
    this.router.navigate(path, { relativeTo: this.route });
  }

  getPosition(id: string) {
    return this.dataSource.data.findIndex(system => system._id === id) + 1;
  }

  getLatestRunDate(id: string) {
    return convertToDateString(this.dataSource.data.find(system => system._id === id)!.runs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0].date);
  }
}
