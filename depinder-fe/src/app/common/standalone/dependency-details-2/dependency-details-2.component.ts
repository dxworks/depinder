import {AfterViewInit, ChangeDetectorRef, Component, OnChanges, OnInit, SimpleChanges, ViewChild} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatButtonModule} from "@angular/material/button";
import {MatIconModule} from "@angular/material/icon";
import {MatToolbarModule} from "@angular/material/toolbar";
import {ToolbarService} from "../../services/toolbar.service";
import {ActivatedRoute} from "@angular/router";
import {LibrariesService} from "../../services/libraries.service";
import {LibraryInfo, LibraryVersion} from "@core/library";
import {convertToDateString, extractDomain, navigateToUrl} from "../../utils";
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {MatPaginator, MatPaginatorModule} from "@angular/material/paginator";
import {Vulnerability} from "@core/vulnerability-checker";
import {VulnerabilitiesTableComponent} from "./vulnerabilities-table/vulnerabilities-table.component";
import {VersionsTableComponent} from "./versions-table/versions-table.component";

@Component({
  selector: 'app-dependency-details-2',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatToolbarModule, MatTableModule, MatPaginatorModule, VulnerabilitiesTableComponent, VersionsTableComponent],
  templateUrl: './dependency-details-2.component.html',
  styleUrl: './dependency-details-2.component.css'
})
export class DependencyDetails2Component implements OnInit {
  id!: string;
  dependency?: LibraryInfo;

  constructor(
    protected toolbarService: ToolbarService,
    private route: ActivatedRoute,
    private librariesService: LibrariesService,
  ) {}

  ngOnInit(): void {
    this.route.params.subscribe(params => {
      this.id = params['depId'];
      this.librariesService.find(this.id).subscribe(dep => {
        this.dependency = dep;
      });
    });
  }

  protected readonly extractDomain = extractDomain;
  protected readonly navigateToUrl = navigateToUrl;
  protected readonly convertToDateString = convertToDateString;
}
