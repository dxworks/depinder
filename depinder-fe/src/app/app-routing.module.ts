import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import {ProjectDetailsComponent} from "./projects/project-details/project-details.component";
import {ProjectsComponent} from "./projects/projects.component";
import {SystemsDetailsComponent} from "./projects/system-collection/systems-details.component";
import {CreateSystemComponent} from "./projects/system-collection/create-system/create-system.component";
import {SystemInfoComponent} from "./projects/system-collection/system-info/system-info.component";

const routes: Routes = [
  { path: 'project/:projectId', component: ProjectDetailsComponent },
  { path: 'projects', component: ProjectsComponent},
  { path: 'create-system', component: CreateSystemComponent},
  { path: 'systems', component: SystemsDetailsComponent},
  { path: 'systems/:id', component: SystemInfoComponent},
  { path: '**', component: ProjectsComponent }
  // { path: '**', component: AppComponent }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }

