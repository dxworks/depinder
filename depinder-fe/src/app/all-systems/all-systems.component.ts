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
import {SharedService} from "../common/services/shared.service";

@Component({
  selector: 'app-systems',
  standalone: true,
    imports: [CommonModule, ProjectsTableComponent, SystemInfoComponent, MatListModule, MatIconModule, MatButtonModule,],
  templateUrl: './all-systems.component.html',
  styleUrl: './all-systems.component.css'
})
export class AllSystemsComponent implements OnInit{
  systems$: System[] = [];
  constructor(private systemService: SystemsService,
              private router: Router,
              private route: ActivatedRoute,
              private sharedService: SharedService) {
  }

  ngOnInit() {
    this.sharedService.updateTitle('Systems');
    this.systemService.all().subscribe(
      (res: any) => {
        this.systems$ = res.body['data'];
      }
    )
  }

  newSystem() {
    this.router.navigate(['systems/new'])
  }

  navigate(path: string[]) {
    this.router.navigate(path, { relativeTo: this.route });
  }
}
