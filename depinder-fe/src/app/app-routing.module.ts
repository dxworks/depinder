import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import {ProjectDetailsComponent} from "./projects/project-details/project-details.component";
import {ProjectsComponent} from "./projects/projects.component";

const routes: Routes = [
  { path: 'project/:projectId', component: ProjectDetailsComponent },
  { path: 'projects', component: ProjectsComponent},
  { path: '**', component: ProjectsComponent }
  // { path: '**', component: AppComponent }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }

