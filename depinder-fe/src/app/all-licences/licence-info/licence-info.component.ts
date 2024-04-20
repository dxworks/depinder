import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {ActivatedRoute} from "@angular/router";
import {LicencesService} from "../../common/services/licences.service";
import {MatButtonModule} from "@angular/material/button";
import {MatIconModule} from "@angular/material/icon";
import {MatToolbarModule} from "@angular/material/toolbar";
import {ToolbarService} from "../../common/services/toolbar.service";
import {Licence} from "@core/licence";
import {LibrariesService} from "../../common/services/libraries.service";
import {DependenciesTableComponent} from "./dependencies-table/dependencies-table.component";
import {LibraryInfo} from "@core/library";
import {extractDomain, navigateToUrl} from "../../common/utils";
import {MatCardModule} from "@angular/material/card";
import {LicenceRulesService} from "../../common/services/licence-rules.service";
import {MatListModule} from "@angular/material/list";
import {MatTooltipModule} from "@angular/material/tooltip";

@Component({
  selector: 'app-licence-info',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatToolbarModule, DependenciesTableComponent, MatCardModule, MatListModule, MatTooltipModule],
  templateUrl: './licence-info.component.html',
  styleUrl: './licence-info.component.css'
})
export class LicenceInfoComponent implements OnInit{
  id!: string;
  licence?: Licence;
  licenceDetails?: any;
  dependencies: LibraryInfo[] = [];

  constructor(private route: ActivatedRoute,
              private licenceService: LicencesService,
              protected toolbarService: ToolbarService,
              private libraryService: LibrariesService,
              protected licenceRulesService: LicenceRulesService) { }

  ngOnInit(): void {
    this.route.params.subscribe(params => {
      this.id = params['id'];
    });
    this.licenceService.getById(this.id).subscribe((data) => {
      if (data.body === null) {
        console.log('No licence found');
        return;
      }
      else {
        this.licence = data.body as Licence;
        console.log(this.licence);
        if (this.licence.detailsUrl !== null) {
          this.licenceService.getLicenceDetails(this.licence.detailsUrl!).subscribe((details) => {
            this.licenceDetails = details.body as Map<String, any>;
            console.log(this.licenceDetails);
          });
        }
        this.libraryService.allWithLicence(this.id).subscribe((libraries) => {
          this.dependencies = libraries as LibraryInfo[];
        });
      }
    });
  }

  protected readonly navigateToUrl = navigateToUrl;
  protected readonly extractDomain = extractDomain;
}
