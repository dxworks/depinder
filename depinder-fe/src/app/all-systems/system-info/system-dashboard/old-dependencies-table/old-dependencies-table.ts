import {Component, Input, OnChanges, SimpleChanges, ViewChild} from '@angular/core';
import { CommonModule } from '@angular/common';
import {Dependency, Project} from "@core/project";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {monthYearToString} from "../../../../common/utils";
import {MatPaginator, MatPaginatorModule} from "@angular/material/paginator";
import {MatInputModule} from "@angular/material/input";
import {MatSelectModule} from "@angular/material/select";
import {FormsModule} from "@angular/forms";
import {MatButtonModule} from "@angular/material/button";
import {MatTooltipModule} from "@angular/material/tooltip";
import {MatIconModule} from "@angular/material/icon";

interface OperationalRiskDependencies {
  dependency: Dependency;
  projects: string[];
  directDep: string[];
  indirectDep: string[];
}

@Component({
  selector: 'app-old-dependencies-table',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatPaginatorModule, MatInputModule, MatSelectModule, FormsModule, MatButtonModule, MatTooltipModule, MatIconModule],
  templateUrl: './old-dependencies-table.html',
  styleUrl: './old-dependencies-table.css'
})
export class OldDependenciesTable implements OnChanges, OnChanges {
  @Input() projects: Project[] = [];
  @Input() filter!: (dep: Dependency) => boolean;

  dependencies: Map<string, OperationalRiskDependencies> = new Map<string, OperationalRiskDependencies>();
  dataSource!: MatTableDataSource<OperationalRiskDependencies>;
  displayedColumns: string[] = ['position', 'name', 'timestamp', 'months-from-today', 'projects-affected', 'direct-deps', 'indirect-deps'];

  @ViewChild(MatPaginator) paginator!: MatPaginator;

  private currentDate = new Date();
  private MILLISECONDS_IN_A_MONTH = 1000 * 60 * 60 * 24 * 30;

  ngOnChanges(changes: SimpleChanges) {
    if (changes['projects']) {
      this.projects = changes['projects'].currentValue;
      this.getDependencies();

      this.dataSource = new MatTableDataSource<OperationalRiskDependencies>(Array.from(this.dependencies.values()));
      this.dataSource.paginator = this.paginator;
    }
  }

  getDependencies() {
    let dependencies = new Map<string, OperationalRiskDependencies>();
    this.projects.forEach(project => {
      project.dependencies.filter(dependency => this.filter(dependency)).forEach(dependency => {
        if (!dependencies.has(dependency._id)) {
          dependencies.set(dependency._id, {
            dependency: dependency,
            projects: [],
            directDep: [],
            indirectDep: []
          });
        }

        let savedDep = dependencies.get(dependency._id)!;

        if (!savedDep.projects.includes(project._id)) {
          !savedDep.projects.push(project._id);
        }

        if (dependency.requestedBy.includes(project._id)) {
          savedDep.directDep.push(project._id);
          savedDep.indirectDep.push(...dependency.requestedBy.filter(value => value !== project._id));
        }
        else {
          savedDep.indirectDep.push(project._id);
        }
      });
    });
    this.dependencies = dependencies;
  }

  dateToString(timestamp: number): string {
    return monthYearToString(timestamp);
  }

  getPosition(dependency: OperationalRiskDependencies): number {
    return this.dataSource.data.indexOf(dependency) + 1;
  }

  getMonthsFromToday(dependency: Dependency): number {
    const dependencyDate = new Date(dependency.timestamp);
    return Math.floor((this.currentDate.getTime() - dependencyDate.getTime()) / this.MILLISECONDS_IN_A_MONTH);
  }
}
