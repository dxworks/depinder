import {Component, EventEmitter, Output} from '@angular/core';
import { CommonModule } from '@angular/common';
import {FormsModule} from "@angular/forms";
import {MatButtonModule} from "@angular/material/button";
import {MatCheckboxChange, MatCheckboxModule} from "@angular/material/checkbox";
import {MatFormFieldModule} from "@angular/material/form-field";
import {MatIconModule} from "@angular/material/icon";
import {MatInputModule} from "@angular/material/input";
import {MatOptionModule} from "@angular/material/core";
import {MatSelectModule} from "@angular/material/select";
import {DependencyFilter} from "../../../models/dependency-filter";

@Component({
  selector: 'app-dependency-filter',
  standalone: true,
    imports: [CommonModule, FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatIconModule, MatInputModule, MatOptionModule, MatSelectModule],
  templateUrl: './dependency-filter.component.html',
  styleUrl: './dependency-filter.component.css'
})
export class DependencyFilterComponent {
  constructor() {
  }

  @Output() filterEmitter = new EventEmitter<DependencyFilter>();

  filter: DependencyFilter = {
    searchField: undefined,
    filterByVulnerabilities: undefined,
    filterByOutdated: undefined,
    filterByOutOfSupport: undefined,
  };

  resetFilters() {
    this.filter = {
      searchField: undefined,
      filterByVulnerabilities: undefined,
      filterByOutdated: undefined,
      filterByOutOfSupport: undefined,
    };
    this.sendFilter();
  }

  sendFilter() {
    this.filterEmitter.emit(this.filter);
  }

  onCheckboxChange(event: MatCheckboxChange, filterProperty: string): void {
    if (filterProperty in this.filter) {
      (this.filter as any)[filterProperty] = event.checked ? true : undefined;
    }
  }
}
