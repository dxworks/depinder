import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import {ProjectDetailsComponent} from "./all-projects/project-details/project-details.component";
import {AllProjectsComponent} from "./all-projects/all-projects.component";
import {AllSystemsComponent} from "./all-systems/all-systems.component";
import {CreateSystemComponent} from "./create-system/create-system.component";
import {SystemInfoComponent} from "./all-systems/system-info/system-info.component";

const routes: Routes = [
  { path: 'project/:projectId', component: ProjectDetailsComponent },
  { path: 'projects', component: AllProjectsComponent},
  { path: 'create-system', component: CreateSystemComponent},
  { path: 'systems', component: AllSystemsComponent},
  { path: 'systems/:id', component: SystemInfoComponent},
  { path: '**', component: AllProjectsComponent }
  // { path: '**', component: AppComponent }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }

