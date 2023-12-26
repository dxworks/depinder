import {Component, Input, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {LicencesService} from "../../services/licences.service";
import {Licence} from "@core/licence";
import {MatIconModule} from "@angular/material/icon";
import {MatRadioModule} from "@angular/material/radio";
import {MatButtonModule} from "@angular/material/button";
import {Router} from "@angular/router";
import {MatDialog} from "@angular/material/dialog";

@Component({
  selector: 'app-licence-label',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatRadioModule, MatButtonModule],
  templateUrl: './licence-label.component.html',
  styleUrl: './licence-label.component.css'
})
export class LicenceLabelComponent implements OnInit {
  @Input() id?: string;
  licence?: Licence;

  constructor(private licencesService: LicencesService, private router: Router, public dialog: MatDialog) {}

  ngOnInit() {
    if (this.id) {
      this.licencesService.getById(this.id).subscribe(response => {
        this.licence = response.body as Licence;
      });
    }
  }

  addLicence() {
    this.router.navigate(['licences/new'],{state: { id: this.id }});
    this.dialog.closeAll();

  }
}
