import {AfterViewInit, Component, Input, OnInit, ViewChild} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatPaginator, MatPaginatorModule} from "@angular/material/paginator";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {Vulnerability} from "@core/vulnerability-checker";
import {extractDomain, navigateToUrl} from "../../../utils";
import {MatButtonModule} from "@angular/material/button";
import {MatIconModule} from "@angular/material/icon";

@Component({
  selector: 'app-vulnerabilities-table',
  standalone: true,
  imports: [CommonModule, MatPaginatorModule, MatTableModule, MatButtonModule, MatIconModule],
  templateUrl: './vulnerabilities-table.component.html',
  styleUrl: './vulnerabilities-table.component.css'
})
export class VulnerabilitiesTableComponent implements OnInit, AfterViewInit {
  @Input() vulnerabilities: Vulnerability[] = [];

  vulnerabilitiesColumns: string[] = ['severity', 'description'];
  vulnerabilitiesDataSource: MatTableDataSource<Vulnerability> = new MatTableDataSource<Vulnerability>();

  @ViewChild(MatPaginator) paginator!: MatPaginator;

  ngOnInit() {
    this.vulnerabilitiesDataSource = new MatTableDataSource(this.vulnerabilities);
    if (this.vulnerabilities.some(v => v.firstPatchedVersion !== undefined)) {
      this.vulnerabilitiesColumns.push('firstPatchedVersion');
    }
    if (this.vulnerabilities.some(v => v.vulnerableRange !== undefined)) {
      this.vulnerabilitiesColumns.push('vulnerableRange');
    }
    if (this.vulnerabilities.some(v => v.references !== undefined)) {
      this.vulnerabilitiesColumns.push('references');
    }
    if (this.vulnerabilities.some(v => v.permalink.length > 0)) {
      this.vulnerabilitiesColumns.push('permalink');
    }
    if (this.vulnerabilities.some(v => v.score !== undefined)) {
      this.vulnerabilitiesColumns.push('score');
    }
  }

  ngAfterViewInit() {
    this.vulnerabilitiesDataSource.paginator = this.paginator;
  }

  protected readonly navigateToUrl = navigateToUrl;
  protected readonly extractDomain = extractDomain;
}
