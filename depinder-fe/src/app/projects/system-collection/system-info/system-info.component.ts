import {Component, Input, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {ProjectsTableComponent} from "../../../common/standalone/projects-table/projects-table.component";
import {ProjectsService} from "../../../common/services/projects.service";
import {System} from "../../../common/models/system";
import {Project} from "../../../common/models/project";

@Component({
  selector: 'app-system-info',
  standalone: true,
    imports: [CommonModule, ProjectsTableComponent],
  templateUrl: './system-info.component.html',
  styleUrl: './system-info.component.css'
})
export class SystemInfoComponent implements OnInit{
  projects$: Project[] = [];
  @Input() system: System | undefined;
  constructor(private projectsService: ProjectsService) { }

  ngOnInit() {
    if (this.system !== undefined) {
      this.system.projects.forEach((projectId, index2) => {
        this.projectsService.find(projectId).subscribe(
          {
            next: (res2: any) => {
              console.log(res2)
              this.projects$ = [res2, ...this.projects$]
            }
          }
        )
      })
    }
  }
}
