import {AfterViewInit, Component, Input, OnInit, ViewChild} from '@angular/core';
import { CommonModule } from '@angular/common';
import {convertToDateString} from "../../../utils";
import {MatPaginator, MatPaginatorModule} from "@angular/material/paginator";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {LibraryVersion} from "@core/library";

@Component({
  selector: 'app-versions-table',
  standalone: true,
  imports: [CommonModule, MatPaginatorModule, MatTableModule],
  templateUrl: './versions-table.component.html',
  styleUrl: './versions-table.component.css'
})
export class VersionsTableComponent implements OnInit, AfterViewInit {
  @Input() versions: LibraryVersion[] = [];

  versionsColumns: string[] = ['version', 'date'];
  versionsDataSource: MatTableDataSource<LibraryVersion> = new MatTableDataSource<LibraryVersion>();

  @ViewChild(MatPaginator) paginator!: MatPaginator;

  ngOnInit(): void {
    this.versionsDataSource = new MatTableDataSource(this.versions);
    this.versionsDataSource.paginator = this.paginator;

    if (this.versions.find((v: LibraryVersion) => v.downloads !== undefined)) {
      this.versionsColumns.push('downloads');
    }
  }

  ngAfterViewInit() {
    this.versionsDataSource.paginator = this.paginator;
  }

  protected readonly convertToDateString = convertToDateString;
}
