import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import {ProjectDetailsComponent} from "./projects/project-details/project-details.component";
import {ProjectsComponent} from "./projects/projects.component";
import {SystemsDetailsComponent} from "./projects/system-collection/systems-details.component";
import {CreateSystemComponent} from "./projects/system-collection/create-system/create-system.component";

const routes: Routes = [
  { path: 'project/:projectId', component: ProjectDetailsComponent },
  { path: 'projects', component: ProjectsComponent},
  { path: 'systems', component: SystemsDetailsComponent},
  { path: 'create-system', component: CreateSystemComponent},
  { path: '**', component: ProjectsComponent }
  // { path: '**', component: AppComponent }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }

