import {Component, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {LicencesService} from "../common/services/licences.service";
import {Licence} from "@core/licence";

@Component({
  selector: 'app-licences',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './licences.component.html',
  styleUrl: './licences.component.css'
})
export class LicencesComponent implements OnInit{
  licences$: Licence[] = [];

  constructor(private licenceService: LicencesService) {}

  ngOnInit() {
    this.licenceService.all().subscribe(
      (res: any) => {
        this.licences$ = res.body as Licence[];
      }
    )
  }
}
