import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {LicencesService} from "../common/services/licences.service";
import {Licence} from "@core/licence";
import {MatTableModule} from "@angular/material/table";
import {MatIconModule} from "@angular/material/icon";
import {MatRadioModule} from "@angular/material/radio";
import {MatButtonModule} from "@angular/material/button";
import {Router} from "@angular/router";

@Component({
  selector: 'app-licences',
  standalone: true,
  imports: [CommonModule, MatTableModule, MatIconModule, MatRadioModule, MatButtonModule],
  templateUrl: './licences.component.html',
  styleUrl: './licences.component.css'
})
export class LicencesComponent implements OnInit{
  licences$: Licence[] = [];
  displayedColumns: string[] = ['_id', 'name', 'isDeprecatedLicenseId', 'isOsiApproved', 'other_ids'];

  constructor(private licenceService: LicencesService, private router: Router) {}

  ngOnInit() {
    this.licenceService.all().subscribe(
      (res: any) => {
        this.licences$ = res.body as Licence[];
      }
    )
  }

  newLicence() {
    this.router.navigate(['licences/new'])
  }
}
