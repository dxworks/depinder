import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import {HttpClientModule} from "@angular/common/http";
import { AppComponent } from './app.component';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { ProjectsComponent } from './projects/projects.component';
import { ProjectDetailsComponent } from './projects/project-details/project-details.component';
import { AppRoutingModule } from './app-routing.module';
import {MatTableModule} from "@angular/material/table";
import {MatButtonModule} from "@angular/material/button";
import {MatInputModule} from "@angular/material/input";
import {FormsModule} from "@angular/forms";
import {MatPaginatorModule} from "@angular/material/paginator";
import {MatSortModule} from "@angular/material/sort";
import {MatCardModule} from "@angular/material/card";
import { MatIconModule } from '@angular/material/icon';
import {MatProgressSpinnerModule} from "@angular/material/progress-spinner";
import {MatSnackBarModule} from "@angular/material/snack-bar";
import { LibraryDetailsComponent } from './projects/project-details/library-details/library-details.component';
import { DependencyRecursiveComponent } from './common/standalone/dependency-recursive/dependency-recursive.component';
import {MatTreeModule} from "@angular/material/tree";
import { DependencyDetailsComponent } from './projects/project-details/dependency-details/dependency-details.component';
import {MatSelectModule} from "@angular/material/select";
import {MatCheckboxModule} from "@angular/material/checkbox";
import {MAT_FORM_FIELD_DEFAULT_OPTIONS} from "@angular/material/form-field";
import {SystemsDetailsComponent} from "./projects/system-collection/systems-details.component";
import {ProjectsTableComponent} from "./common/standalone/projects-table/projects-table.component";
import {DependencyFilterComponent} from "./projects/project-details/dependency-filter/dependency-filter.component";
import {CreateSystemComponent} from "./projects/system-collection/create-system/create-system.component";

@NgModule({
  declarations: [
    AppComponent,
    ProjectsComponent,
    ProjectDetailsComponent,
    LibraryDetailsComponent,
    DependencyDetailsComponent,
  ],
    imports: [
        BrowserModule,
        BrowserAnimationsModule,
        HttpClientModule,
        AppRoutingModule,
        MatTableModule,
        MatButtonModule,
        MatInputModule,
        FormsModule,
        MatPaginatorModule,
        MatSortModule,
        MatCardModule,
        MatIconModule,
        MatProgressSpinnerModule,
        MatSnackBarModule,
        MatTreeModule,
        MatSelectModule,
        MatCheckboxModule,
        DependencyRecursiveComponent,
        SystemsDetailsComponent,
        ProjectsTableComponent,
        DependencyFilterComponent,
        CreateSystemComponent
    ],
  providers: [
    {provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: {appearance: 'outline'}}
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
