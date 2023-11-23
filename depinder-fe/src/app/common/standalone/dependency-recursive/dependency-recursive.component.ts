import {Component, EventEmitter, Input, Output} from '@angular/core';
import {Dependency} from "../../models/project";
import {TreeNode} from "../../models/tree";
import {of} from "rxjs";
import {MatIconModule} from "@angular/material/icon";
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";
import {JsonPipe, NgClass, NgIf} from "@angular/common";
import {DependencyFilter} from "../../models/dependency-filter";

@Component({
  selector: 'app-dependency-recursive',
  templateUrl: './dependency-recursive.component.html',
  styleUrls: ['./dependency-recursive.component.css'],
  standalone: true,
  imports: [
    MatIconModule,
    MatProgressSpinnerModule,
    NgIf,
    NgClass,
    JsonPipe
  ]
})
export class DependencyRecursiveComponent {
  @Input() depth: number = 0;

  @Input() dependency?: Dependency;

  //todo change name
  @Input() allDependencies: TreeNode[] = [];

  @Input() showMore: boolean = false;

  @Output() childEvent = new EventEmitter<Dependency>();

  @Input() filter!: DependencyFilter;

  constructor() { }

  containsFilters(index: number): boolean {
    const searchFieldTrimmed = this.filter.searchField?.trim()
    // console.log('searchFieldTrimmed', searchFieldTrimmed)
    const isSearchFieldEmpty = !searchFieldTrimmed; // true if searchField is undefined or empty
    // console.log('isSearchFieldEmpty', isSearchFieldEmpty)
    const isFilterByVulnerabilitiesUndefined = this.filter.filterByVulnerabilities === undefined;
    // console.log('isFilterByVulnerabilitiesUndefined', isFilterByVulnerabilitiesUndefined)
    const isFilterByOutOfSupportUndefined = this.filter.filterByOutOfSupport === undefined;
    // console.log('isFilterByOutOfSupportUndefined', isFilterByOutOfSupportUndefined)
    const isFilterByOutdatedUndefined = this.filter.filterByOutdated === undefined;
    // console.log('isFilterByOutdatedUndefined', isFilterByOutdatedUndefined)

    // // Return false if both search field and filterByVulnerabilities are not set
    // if (isSearchFieldEmpty && isFilterByVulnerabilitiesUndefined && isFilterByOutOfSupportUndefined && isFilterByOutdatedUndefined && this.depth === 0) {
    //   return true;
    // }
    if (isSearchFieldEmpty && isFilterByVulnerabilitiesUndefined && isFilterByOutOfSupportUndefined && isFilterByOutdatedUndefined)
      return false;

    return this.allDependencies[index].contains(searchFieldTrimmed, this.filter.filterByVulnerabilities, this.filter.filterByOutOfSupport, this.filter.filterByOutdated);
  }

  toggle() {
    this.sendInfo();
    this.showMore = !this.showMore;
  }

  isHighlighted(): boolean {
    const nameMatch = (this.filter.searchField === undefined || this.filter.searchField.trim().length > 0) && (this.dependency?.name.includes(this.filter.searchField ?? '') ?? false);

    //todo check why comparisons don't work with boolean
    const vulnerabilitiesMatch = this.filter.filterByVulnerabilities === undefined || `${this.dependency?.vulnerabilities}` === `${this.filter.filterByVulnerabilities}`;
    const outOfSupportMatch = this.filter.filterByOutOfSupport === undefined || `${this.dependency?.outOfSupport}` === `${this.filter.filterByOutOfSupport}`;
    const outOfDateMatch = this.filter.filterByOutdated === undefined || `${this.dependency?.outdated}` === `${this.filter.filterByOutdated}`;

    if (((this.filter.searchField === undefined || this.filter.searchField.trim().length == 0)) && this.filter.filterByVulnerabilities === undefined && this.filter.filterByOutOfSupport === undefined && this.filter.filterByOutdated === undefined)
      return false;

    return (vulnerabilitiesMatch && (outOfSupportMatch) && outOfDateMatch && nameMatch);
  }

  sendInfo() {
    this.childEvent.emit(this.dependency);
  }

  receiveInfo($event: any) {
    this.childEvent.emit($event);
  }
}
