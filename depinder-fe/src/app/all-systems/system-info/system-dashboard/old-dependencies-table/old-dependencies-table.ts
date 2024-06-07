import {AfterViewInit, Component, Input, OnChanges, SimpleChanges, ViewChild} from '@angular/core';
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
import {LibraryInfo} from "@core/library";
import {MatSort, MatSortModule} from "@angular/material/sort";
import {MatListModule} from "@angular/material/list";
import {animate, state, style, transition, trigger} from "@angular/animations";
import {OldDepDetailsComponent} from "./old-dep-details/old-dep-details.component";

export interface ProjectDependency {
  projectId: string;
  dependencyVersions: Set<string>;
}

export interface OperationalRiskDependencies {
  dependency: Dependency;
  name: string;
  library: LibraryInfo;
  lastUpdated: number;
  projects: ProjectDependency[];
  directDep: ProjectDependency[];
  indirectDep: ProjectDependency[];
}

@Component({
  selector: 'app-old-dependencies-table',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatPaginatorModule, MatInputModule, MatSelectModule, FormsModule, MatButtonModule, MatTooltipModule, MatIconModule, MatSortModule, MatListModule, OldDepDetailsComponent],
  templateUrl: './old-dependencies-table.html',
  styleUrl: './old-dependencies-table.css',
  animations: [
    trigger('detailExpand', [
      state('collapsed,void', style({height: '0px', minHeight: '0'})),
      state('expanded', style({height: '*'})),
      transition('expanded <=> collapsed', animate('225ms cubic-bezier(0.4, 0.0, 0.2, 1)')),
    ]),
  ],
})
export class OldDependenciesTable implements OnChanges, OnChanges, AfterViewInit {
  @Input() projects?: Project[] = [];
  @Input() libraries?: Map<string, LibraryInfo>;
  @Input() filter!: (dep: LibraryInfo) => boolean;

  dependencies: Map<string, OperationalRiskDependencies> = new Map<string, OperationalRiskDependencies>();
  dataSource!: MatTableDataSource<OperationalRiskDependencies>;
  displayedColumns: string[] = ['name', 'lastUpdated', 'months-from-today', 'projects-affected', 'direct-deps', 'indirect-deps',];

  expandedElement?: OperationalRiskDependencies;

  @ViewChild(MatPaginator) paginator!: MatPaginator;
  @ViewChild(MatSort) sort!: MatSort;

  private currentDate = new Date();
  private MILLISECONDS_IN_A_MONTH = 1000 * 60 * 60 * 24 * 30;

  ngOnChanges(changes: SimpleChanges) {
    if (changes['projects'] && changes['projects'].currentValue !== changes['projects'].previousValue && changes['projects'].currentValue.length > 0) {
      this.projects = changes['projects'].currentValue;
    }

    if (changes['libraries'] && changes['libraries'].currentValue !== changes['libraries'].previousValue) {
      this.libraries = changes['libraries'].currentValue;
    }

    if (this.projects !== undefined && this.libraries !== undefined) {
      this.filterDependencies();

      if (this.dependencies.size > 0) {
        this.dataSource = new MatTableDataSource(Array.from(this.dependencies.values()).sort((a, b) => a.lastUpdated - b.lastUpdated));
      }
    }
  }

  ngAfterViewInit() {
    this.dataSource.paginator = this.paginator;
    this.dataSource.sort = this.sort;
  }

  filterDependencies() {
    let dependencies = new Map<string, OperationalRiskDependencies>();
    this.projects!.forEach(project => {
      project.dependencies.filter(dependency => {
        let library = this.libraries!.get(dependency.name);
        return library !== undefined && this.filter(library);
      }).forEach(dependency => {
        if (!dependencies.has(dependency._id)) {
          let library = this.libraries!.get(dependency.name)!;
          dependencies.set(dependency._id, {
            dependency: dependency,
            name: dependency.name,
            library: library,
            projects: [],
            directDep: [],
            indirectDep: [],
            lastUpdated: library.versions.find((version) => version.latest)!.timestamp
          });
        }

        let savedDep = dependencies.get(dependency._id)!;

        let projectDependency = savedDep.projects.findIndex(value => {
          return value.projectId === project._id;
        });

        if (projectDependency != -1) {
          savedDep.projects[projectDependency].dependencyVersions.add(dependency.version)
        }
        else {
          savedDep.projects.push({
            projectId: project._id,
            dependencyVersions: new Set([dependency.version])
          });
        }

        if (dependency.directDep) {
          let requestedDirectDependency = savedDep.directDep.findIndex(value => value.projectId === project._id);
          if (requestedDirectDependency != -1) {
            savedDep.directDep[requestedDirectDependency].dependencyVersions.add(dependency.version)
          }
          else {
            savedDep.directDep.push({
              projectId: project._id,
              dependencyVersions: new Set([dependency.version])
            });
          }
        }

        /// Indirect dependencies
        dependency.requestedBy.filter(requestedBy => requestedBy !== project._id).forEach(requestedBy => {
          let requestedIndirectDependency = savedDep.indirectDep.findIndex(value => value.projectId === requestedBy);
          if (requestedIndirectDependency != -1) {
            savedDep.indirectDep[requestedIndirectDependency].dependencyVersions.add(dependency.version);
          }
          else {
            savedDep.indirectDep.push({
              projectId: requestedBy,
              dependencyVersions: new Set([dependency.version])
            });
          }
        });

      });
    });

    this.dependencies = dependencies;
  }

  dateToString(timestamp: number): string {
    return monthYearToString(timestamp);
  }

  getMonthsFromToday(timestamp: number): number {
    const dependencyDate = new Date(timestamp);
    return Math.floor((this.currentDate.getTime() - dependencyDate.getTime()) / this.MILLISECONDS_IN_A_MONTH);
  }
}
