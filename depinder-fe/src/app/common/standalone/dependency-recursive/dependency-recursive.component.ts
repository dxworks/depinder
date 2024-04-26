import {Component, EventEmitter, Input, OnInit, Output} from '@angular/core';
import {TreeNode} from "../../models/tree";
import {MatIconModule} from "@angular/material/icon";
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";
import {JsonPipe, NgClass, NgIf, NgStyle} from "@angular/common";
import {DependencyFilter} from "../../models/dependency-filter";
import { Dependency } from '@core/project';
import {MatButtonModule} from "@angular/material/button";
import {ActivatedRoute, Router} from "@angular/router";
import {MatTreeModule} from "@angular/material/tree";

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
    JsonPipe,
    NgStyle,
    MatButtonModule,
    MatTreeModule
  ]
})
export class DependencyRecursiveComponent implements OnInit {
  @Input() depth: number = 0;

  @Input() dependency?: Dependency;

  //todo change name
  @Input() allDependencies: TreeNode[] = [];

  @Input() showMore: boolean = true;

  @Output() childEvent = new EventEmitter<Dependency>();

  @Input() filter!: DependencyFilter;

  constructor(
    private router: Router,
    private route: ActivatedRoute,
  ) { }

  ngOnInit(): void {
    this.allDependencies.sort((a, b) => a.data.name.localeCompare(b.data.name));
  }

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
  }

  showMoreToggle() {
    this.showMore = !this.showMore;
  }

  isHighlighted(): boolean {
    const name = this.dependency?.name + '@' + this.dependency?.version;
    const nameMatch = (this.filter.searchField === undefined || this.filter.searchField.trim().length > 0) && (name.includes(this.filter.searchField ?? '') ?? false);

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

  public getPadding(): object {
    return this.depth > 0 ? {'padding-left': '2rem'} : {'padding-left': '0rem'};
  }

  navigateToDependency() {
    const url = this.router.createUrlTree(['/dependency', this.dependency?._id], {relativeTo: this.route}).toString();
    window.open(url, '_blank');
  }
}
