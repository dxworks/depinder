import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import {ProjectDetailsComponent} from "./all-projects/project-details/project-details.component";
import {AllProjectsComponent} from "./all-projects/all-projects.component";
import {AllSystemsComponent} from "./all-systems/all-systems.component";
import {CreateSystemComponent} from "./all-systems/create-system/create-system.component";
import {SystemInfoComponent} from "./all-systems/system-info/system-info.component";
import {SystemEditComponent} from "./all-systems/system-edit/system-edit.component";
import {LicencesComponent} from "./all-licences/licences.component";
import {AddLicenceComponent} from "./all-licences/add-licence/add-licence.component";
import {LicenceInfoComponent} from "./all-licences/licence-info/licence-info.component";
import {
  DependencyDetailsComponent
} from "./common/standalone/dependencies/dependency-details/dependency-details.component";
import {DependencyDetails2Component} from "./common/standalone/dependency-details-2/dependency-details-2.component";

const routes: Routes = [
  { path: 'project/:projectId', component: ProjectDetailsComponent },
  { path: 'projects', component: AllProjectsComponent},
  { path: 'systems', component: AllSystemsComponent},
  { path: 'systems/new', component: CreateSystemComponent},
  { path: 'systems/:id', component: SystemInfoComponent},
  { path: 'dependency/:depId', component: DependencyDetails2Component},
  { path: 'systems/:id/edit', component: SystemEditComponent},
  { path: 'licences/new', component: AddLicenceComponent},
  { path: 'licences/edit', component: AddLicenceComponent, data: {editMode: true}},
  { path: 'licences/:id', component: LicenceInfoComponent},
  { path: 'licences', component: LicencesComponent},
  { path: '**', component: AllProjectsComponent }
  // { path: '**', component: AppComponent }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }

