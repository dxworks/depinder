import {Component, Input, OnChanges, OnInit, SimpleChanges, ViewChild} from '@angular/core';
import { CommonModule } from '@angular/common';
import {Dependency, Project} from "@core/project";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {convertToDateString} from "../../../../common/utils";
import {OUT_OF_SUPPORT_MONTHS, OUTDATED_MONTHS} from "@core/constants";
import {MatPaginator, MatPaginatorModule} from "@angular/material/paginator";
import {MatInputModule} from "@angular/material/input";
import {MatSelectModule} from "@angular/material/select";
import {FormsModule} from "@angular/forms";

interface OperationalRiskDependencies {
  _id: string;
  position: number;
  dependency: Dependency;
  projects: Project[];
}

@Component({
  selector: 'app-operational-risk',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatPaginatorModule, MatInputModule, MatSelectModule, FormsModule],
  templateUrl: './operational-risk.component.html',
  styleUrl: './operational-risk.component.css'
})
export class OperationalRiskComponent implements OnChanges, OnInit, OnChanges {
  @Input() projects: Project[] = [];

  dependencies: Map<string, Project[]> = new Map<string, Project[]>();
  dataSource!: MatTableDataSource<Dependency>;
  displayedColumns: string[] = ['position', 'name', 'state', 'timestamp', 'uses'];
  states: string[] = ['outdated', 'out of support'];
  selectedState?: string;

  @ViewChild(MatPaginator) paginator!: MatPaginator;

  private currentDate = new Date();
  private outdatedThreshold =  new Date(this.currentDate.getFullYear(),
    this.currentDate.getMonth() - OUTDATED_MONTHS, this.currentDate.getDate());
  private outOfSupportThreshold =  new Date(this.currentDate.getFullYear(),
    this.currentDate.getMonth() - OUT_OF_SUPPORT_MONTHS, this.currentDate.getDate());

  ngOnInit() {
    this.getDependencies();
  }

  ngOnChanges(changes: SimpleChanges) {
    console.log(changes)
    if (changes['projects']) {
      this.projects = changes['projects'].currentValue;
      this.getDependencies();

      let sortedDependencies = this.getData();

      this.dataSource = new MatTableDataSource<Dependency>(sortedDependencies);
      this.dataSource.paginator = this.paginator;
    }
  }

  getData(): Dependency[] {
    const currentDate = new Date();
    currentDate.setMonth(currentDate.getMonth() - OUTDATED_MONTHS);

    let dependencies = this.projects.map(project => project.dependencies.filter(value => value.directDep)).flat();

    return Array.from(dependencies).filter(dependency => {
      return new Date(dependency.timestamp) < currentDate;
    }).sort((a, b) => {
      return a.name.localeCompare(b.name);
    });
  }

  getDependencies() {
    let dependencies = new Map<string, Project[]>();
    this.projects.forEach(project => {
      project.dependencies.filter(value => value.directDep).forEach(dependency => {
        if (dependencies.has(dependency._id)) {
          console.log('duplicate dependency', dependency, project)
          dependencies.get(dependency._id)?.push(project);
        } else {
          dependencies.set(dependency._id, [project]);
        }
      });
    });
    this.dependencies = dependencies;
  }

  filterByState() {
    if (this.selectedState === undefined) {
      this.dataSource = new MatTableDataSource<Dependency>(this.getData());
      this.dataSource.paginator = this.paginator;
    }
    else {
      this.dataSource = new MatTableDataSource<Dependency>(this.getData().filter(dependency => {
        return this.outdatedOrOutOfSupport(dependency) === this.selectedState;
      }));
    }
    this.dataSource.paginator = this.paginator;
    this.paginator.firstPage();
  }

  dateToString(timestamp: number): string {
    return this.convertToDateString(timestamp);
  }

  getPosition(dependency: Dependency): number {
    return this.dataSource.data.indexOf(dependency) + 1;
  }

  outdatedOrOutOfSupport(dependency: Dependency): string {
    const dependencyDate = new Date(dependency.timestamp);

    if (dependencyDate < this.outOfSupportThreshold) {
      return 'out of support';
    } else if (dependencyDate < this.outdatedThreshold) {
      return 'outdated';
    } else {
      return 'up to date';
    }
  }

  getNumberOfProjects(dependency: Dependency): number {
    return this.dependencies.get(dependency._id)?.length || 0;
  }

  protected readonly convertToDateString = convertToDateString;
  protected readonly OUTDATED_MONTHS = OUTDATED_MONTHS;
  protected readonly OUT_OF_SUPPORT_MONTHS = OUT_OF_SUPPORT_MONTHS;
}
