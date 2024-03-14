import {Component, Input, OnInit} from '@angular/core';
import { CommonModule } from '@angular/common';
import {MatTableDataSource, MatTableModule} from "@angular/material/table";
import {TableElement} from "../system-licences-2.component";
import {MatButtonModule} from "@angular/material/button";
import {MatCheckboxModule} from "@angular/material/checkbox";
import {MatIconModule} from "@angular/material/icon";
import {MatMenuModule} from "@angular/material/menu";
import {Router} from "@angular/router";

@Component({
  selector: 'app-existing-licence',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCheckboxModule, MatTableModule, MatIconModule, MatMenuModule],
  templateUrl: './existing-licence.component.html',
  styleUrl: './existing-licence.component.css'
})
export class ExistingLicenceComponent implements OnInit {
  displayedColumns: string[] = ['position', 'name', 'dependencies', 'isOsiApproved', 'isCustom', 'actions'];
  @Input() data: TableElement[] = [];
  dataSource = new MatTableDataSource<TableElement>([]);

  constructor(private router: Router) {
  }

  ngOnInit() {
    this.dataSource = new MatTableDataSource<TableElement>(this.data);
  }

  getPosition(id: string) {
    return this.dataSource.data.findIndex((element) => element.name === id) + 1;
  }

  navigateToEdit(id: string) {
    this.router.navigate(['licences/edit'], {state: { id: id }}).catch(error => {
      console.error('Error navigating to edit page:', error);
    });
  }
}
