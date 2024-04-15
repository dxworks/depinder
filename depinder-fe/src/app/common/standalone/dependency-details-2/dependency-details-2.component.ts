import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatButtonModule} from "@angular/material/button";
import {MatIconModule} from "@angular/material/icon";
import {MatToolbarModule} from "@angular/material/toolbar";
import {ToolbarService} from "../../services/toolbar.service";
import {ActivatedRoute} from "@angular/router";
import {LibrariesService} from "../../services/libraries.service";
import {LibraryInfo} from "@core/library";
import {extractDomain, navigateToUrl} from "../../utils";
import {MatTableModule} from "@angular/material/table";
import {MatPaginatorModule} from "@angular/material/paginator";
import {VulnerabilitiesTableComponent} from "./vulnerabilities-table/vulnerabilities-table.component";
import {VersionsTableComponent} from "./versions-table/versions-table.component";
import {MatCardModule} from "@angular/material/card";
import {MatListModule} from "@angular/material/list";
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";

@Component({
  selector: 'app-dependency-details-2',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatToolbarModule, MatTableModule, MatPaginatorModule, VulnerabilitiesTableComponent, VersionsTableComponent, MatCardModule, MatListModule, MatProgressSpinnerModule],
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

  packageUrl(): string | undefined {
    let packageType = this.id.split(':')[0];
    switch (packageType) {
      case 'npm':
        return 'https://www.npmjs.com/package/' + this.id.split(':')[1];
      case 'maven':
        return 'https://search.maven.org/artifact/' + this.id.split(':')[1];
      case 'pypi':
        return 'https://pypi.org/project/' + this.id.split(':')[1];
      case 'rubygems':
        return 'https://rubygems.org/gems/' + this.id.split(':')[1];
      case 'nuget':
        return 'https://www.nuget.org/packages/' + this.id.split(':')[1];
      case 'composer':
        return 'https://packagist.org/packages/' + this.id.split(':')[1];
      case 'dotnet':
        return 'https://www.nuget.org/packages/' + this.id.split(':')[1];
      case 'php':
        return 'https://packagist.org/packages/' + this.id.split(':')[1];
      default :
        return undefined;
    }
  }

  protected readonly extractDomain = extractDomain;
  protected readonly navigateToUrl = navigateToUrl;
}
