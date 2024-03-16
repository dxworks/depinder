import {AfterViewInit, Component, Input, OnChanges, SimpleChanges, ViewChild} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {MatSort, MatSortModule} from "@angular/material/sort";
import {LibraryInfo} from "@core/library";
import {MatPaginator, MatPaginatorModule} from "@angular/material/paginator";
import {FormsModule, ReactiveFormsModule} from "@angular/forms";
import {MatFormFieldModule} from "@angular/material/form-field";
import {MatSelectModule} from "@angular/material/select";

@Component({
  selector: 'app-dependencies-table',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatSortModule, MatPaginatorModule, FormsModule, MatFormFieldModule, MatSelectModule, ReactiveFormsModule],
  templateUrl: './dependencies-table.component.html',
  styleUrl: './dependencies-table.component.css'
})
export class DependenciesTableComponent implements AfterViewInit, OnChanges {
  @Input() dependencies: LibraryInfo[] = [];

  dataSource!: MatTableDataSource<LibraryInfo>;
  allColumns: { columnDef: string; header: string; visible: boolean; couldBeVisible: any}[] = [
    { columnDef: 'name', header: 'Name', visible: true, couldBeVisible: () => true},
    { columnDef: 'description', header: 'Description', visible: true, couldBeVisible: () => true },
    { columnDef: 'keywords', header: 'Keywords', visible: true, couldBeVisible: () => this.dependencies.find((value) => value.keywords !== undefined) !== undefined },
    { columnDef: 'reposUrl', header: 'Repository URL', visible: true, couldBeVisible: () =>  this.dependencies.find((value) => value.reposUrl !== undefined && value.reposUrl.length > 0) !== undefined },
    { columnDef: 'homepageUrl', header: 'Homepage URL', visible: true, couldBeVisible:() =>  this.dependencies.find((value) => value.homepageUrl !== undefined && value.homepageUrl.length > 0) !== undefined },
    { columnDef: 'documentationUrl', header: 'Documentation URL',visible: true, couldBeVisible: () => this.dependencies.find((value) => value.documentationUrl !== undefined && value.documentationUrl.length > 0) !== undefined },
    { columnDef: 'downloads', header: 'Downloads',visible: true, couldBeVisible: () => this.dependencies.find((value) => value.downloads !== undefined) !== undefined},
    { columnDef: 'packageUrl', header: 'Package URL',visible: true, couldBeVisible: () => this.dependencies.find((value) => value.packageUrl !== undefined && value.packageUrl.length > 0) !== undefined},
    { columnDef: 'authors', header: 'Authors',visible: true, couldBeVisible: () => this.dependencies.find((value) => value.authors !== undefined && value.authors.length > 0) !== undefined},
    { columnDef: 'vulnerabilities', header: 'Vulnerabilities', visible: true, couldBeVisible:() =>  this.dependencies.find((value) => value.vulnerabilities !== undefined && value.vulnerabilities.length > 0) !== undefined }
  ];
  displayedColumns: string[] = this.allColumns.map(c => c.columnDef);

  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild(MatPaginator) paginator!: MatPaginator;

  constructor() {
    this.selectedColumns = this.allColumns.filter(c => c.visible).map(c => c.columnDef);
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['dependencies']) {
      this.dataSource = new MatTableDataSource<LibraryInfo>(this.dependencies);
      if (this.sort) {
        this.dataSource.sort = this.sort;
      }
      if (this.paginator) {
        this.dataSource.paginator = this.paginator;
      }
      this.selectedColumns = this.allColumns.filter(c => c.couldBeVisible() === true).map(c => c.columnDef)
      this.updateDisplayedColumns();
    }
  }

  ngAfterViewInit() {
    if (this.dataSource) {
      this.dataSource.sort = this.sort;
      this.dataSource.paginator = this.paginator;
    }
  }

  updateDisplayedColumns(): void {
    this.displayedColumns = this.selectedColumns;
  }

  allCouldBeVisible() {
    return this.allColumns.filter(c => c.couldBeVisible() === true)
  }

  public selectedColumns: string[] = this.allColumns.filter(c => c.couldBeVisible() === true).map(c => c.columnDef);
}
