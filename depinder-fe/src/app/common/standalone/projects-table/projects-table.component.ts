import {Component, Input} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatTableModule} from "@angular/material/table";
import {Router} from "@angular/router";
import { Project } from '@core/project';

@Component({
  selector: 'app-projects-table',
  standalone: true,
    imports: [CommonModule, MatTableModule],
  templateUrl: './projects-table.component.html',
  styleUrl: './projects-table.component.css'
})
export class ProjectsTableComponent {

  constructor(private router: Router,) {
  }

  @Input() projects: Project[] = [];
  displayedColumns: string[] = ['name', 'projectPath'];

  navigate(projectId: string) {
    this.router.navigate(['/project', projectId]);
  }

}
